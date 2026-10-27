import type { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES } from '@workforce/shared';

export const ROLE_NAMES: Record<string, { name: string; nameAr: string }> = {
  SUPER_ADMIN: { name: 'Super Admin', nameAr: 'مدير النظام' },
  HR_ADMIN: { name: 'HR Administrator', nameAr: 'الموارد البشرية' },
  GENERAL_MANAGER: { name: 'General Manager', nameAr: 'المدير العام' },
  DEPARTMENT_MANAGER: { name: 'Department Manager', nameAr: 'مدير قسم' },
  PROJECT_MANAGER: { name: 'Project Manager', nameAr: 'مدير مشروع' },
  EMPLOYEE: { name: 'Employee', nameAr: 'موظف' },
};

/**
 * Idempotently creates the permission catalog and the built-in roles that are missing. Used by the seed
 * and by tests. An existing role is left exactly as it is: the admin may have changed its permissions
 * in Roles & permissions, and a re-seed must not give back what was taken away. SUPER_ADMIN is the
 * exception and always holds every permission, including ones added to the catalog later.
 */
export async function ensureRbac(prisma: PrismaClient): Promise<void> {
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  const perms = await prisma.permission.findMany();
  const idByKey = new Map(perms.map((p) => [p.key, p.id]));
  for (const key of Object.values(SYSTEM_ROLES)) {
    const existing = await prisma.role.findUnique({ where: { key } });
    if (existing && key !== SYSTEM_ROLES.SUPER_ADMIN) continue;
    const role = existing ?? (await prisma.role.create({ data: { key, ...ROLE_NAMES[key], isSystem: true } }));
    await prisma.rolePermission.createMany({
      data: DEFAULT_ROLE_PERMISSIONS[key].map((p) => ({ roleId: role.id, permissionId: idByKey.get(p)! })),
      skipDuplicates: true,
    });
  }
}
