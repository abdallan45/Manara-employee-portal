import type { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES } from '@workforce/shared';

const ROLE_NAMES: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  HR_ADMIN: 'HR Administrator',
  DEPARTMENT_MANAGER: 'Department Manager',
  EMPLOYEE: 'Employee',
};

/** Idempotently creates the permission catalog and built-in roles. Used by the seed and by tests. */
export async function ensureRbac(prisma: PrismaClient): Promise<void> {
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
  }
  const perms = await prisma.permission.findMany();
  const idByKey = new Map(perms.map((p) => [p.key, p.id]));
  for (const key of Object.values(SYSTEM_ROLES)) {
    const role = await prisma.role.upsert({
      where: { key },
      update: {},
      create: { key, name: ROLE_NAMES[key], isSystem: true },
    });
    for (const p of DEFAULT_ROLE_PERMISSIONS[key]) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: idByKey.get(p)! } },
        update: {},
        create: { roleId: role.id, permissionId: idByKey.get(p)! },
      });
    }
  }
}
