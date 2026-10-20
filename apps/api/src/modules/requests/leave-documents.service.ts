import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  LEAVE_DOCUMENT_MAX_BYTES, LEAVE_DOCUMENT_MAX_COUNT, LEAVE_DOCUMENT_TYPES, PERMISSIONS, type LeaveDocumentDto,
} from '@workforce/shared';
import { AppError } from '../../common/app-error';
import type { AuthUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { approverFor } from './approval-routing';
import { LeaveService } from './leave.service';
import { TX_OPTIONS } from './request-common';

/** The parts of a multer file we use (memory storage). */
export interface UploadedDocument {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

type DocumentType = (typeof LEAVE_DOCUMENT_TYPES)[number];

/** Content type from the first bytes; the browser-supplied type and the file name are not trusted. */
export function sniffDocumentType(buf: Buffer): DocumentType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

const EXTENSION: Record<DocumentType, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

/** Keeps the readable part of a name (Arabic included), drops path parts and control characters, fixes the extension. */
export function cleanFileName(name: string, type: DocumentType): string {
  // multer decodes the multipart filename as latin1; browsers send UTF-8.
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  const decoded = utf8.includes('�') ? name : utf8;
  // Also drops bidi controls (LRM/RLM, embeddings/overrides, isolates) that can disguise the real extension.
  const base = decoded.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"<>|:*?‎‏‪-‮⁦-⁩]/g, '').trim();
  const stem = base.replace(/\.[^.]*$/, '').slice(0, 100) || 'document';
  return `${stem}${EXTENSION[type]}`;
}

export const documentToDto = (d: { id: string; fileName: string; mimeType: string; size: number; createdAt: Date; uploadedById: string }): LeaveDocumentDto => ({
  id: d.id, fileName: d.fileName, mimeType: d.mimeType, size: d.size, createdAt: d.createdAt.toISOString(), uploadedById: d.uploadedById,
});

/**
 * Supporting documents of leave requests (images and PDF, stored in the database).
 * - The requester adds documents while the request is pending or approved, and removes their own while pending.
 * - HR (leave approvers with company-wide scope) may add or remove documents on any request that is not cancelled.
 * - Anyone who may see the request may open its documents, except that sensitive types stay hidden from
 *   department managers (same rule as the request's type and reason).
 */
@Injectable()
export class LeaveDocumentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly leave: LeaveService) {}

  private isHr(user: AuthUser) {
    return approverFor(user, PERMISSIONS.LEAVE_APPROVE)?.companyWide === true;
  }

  async add(user: AuthUser, leaveRequestId: string, file: UploadedDocument | undefined): Promise<LeaveDocumentDto> {
    if (!file || !file.buffer?.length) throw AppError.badRequest('VALIDATION_FAILED', 'Attach a file in the "file" field', [{ field: 'file', messages: ['file is required'] }]);
    if (file.size > LEAVE_DOCUMENT_MAX_BYTES) {
      throw AppError.badRequest('ATTACHMENT_TOO_LARGE', `A document may be at most ${LEAVE_DOCUMENT_MAX_BYTES / 1024 / 1024} MB`, { maxBytes: LEAVE_DOCUMENT_MAX_BYTES });
    }
    const type = sniffDocumentType(file.buffer);
    if (!type) throw AppError.badRequest('ATTACHMENT_TYPE_NOT_ALLOWED', 'Only JPEG, PNG, WebP images and PDF documents are accepted', { allowed: LEAVE_DOCUMENT_TYPES });

    const request = await this.prisma.leaveRequest.findUnique({ where: { id: leaveRequestId }, select: { id: true, employeeId: true, status: true } });
    if (!request) throw AppError.notFound('Leave request not found');
    const own = request.employeeId === user.employeeId;
    const hr = this.isHr(user);
    if (!own && !hr) {
      // Out-of-scope requests look missing; in-scope ones (managers) are a permission problem.
      await this.leave.getFor(user, leaveRequestId);
      throw AppError.forbidden('ATTACHMENT_NOT_ALLOWED', 'Only the requester or HR can add documents');
    }
    const open = own && !hr ? ['PENDING', 'APPROVED'].includes(request.status) : request.status !== 'CANCELLED';
    if (!open) throw AppError.conflict('ATTACHMENT_NOT_ALLOWED', 'Documents can no longer be added to this request', { status: request.status });

    const fileName = cleanFileName(file.originalname, type);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    return this.prisma.$transaction(async (tx) => {
      // Serialise concurrent uploads to one request so the count limit holds.
      await tx.$executeRaw`SELECT id FROM leave_requests WHERE id = ${leaveRequestId}::uuid FOR UPDATE`;
      const count = await tx.leaveAttachment.count({ where: { leaveRequestId } });
      if (count >= LEAVE_DOCUMENT_MAX_COUNT) {
        throw AppError.conflict('ATTACHMENT_LIMIT_REACHED', `A request may have at most ${LEAVE_DOCUMENT_MAX_COUNT} documents`, { max: LEAVE_DOCUMENT_MAX_COUNT });
      }
      const row = await tx.leaveAttachment.create({
        data: { leaveRequestId, fileName, mimeType: type, size: file.buffer.length, sha256, data: file.buffer, uploadedById: user.userId },
        select: { id: true, fileName: true, mimeType: true, size: true, createdAt: true, uploadedById: true },
      });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'LEAVE_DOCUMENT_ADD', entityType: 'LeaveRequest', entityId: leaveRequestId, ipAddress: user.ip,
        after: { documentId: row.id, fileName, mimeType: type, size: row.size, sha256 },
      });
      return documentToDto(row);
    }, TX_OPTIONS);
  }

  /** The file, for a viewer allowed to see it. */
  async content(user: AuthUser, documentId: string): Promise<{ fileName: string; mimeType: string; data: Buffer }> {
    const doc = await this.prisma.leaveAttachment.findUnique({ where: { id: documentId }, select: { leaveRequestId: true } });
    if (!doc) throw AppError.notFound('Document not found');
    const request = await this.leave.getFor(user, doc.leaveRequestId).catch(() => {
      throw AppError.notFound('Document not found');
    });
    if (request.confidential) throw AppError.notFound('Document not found');
    const row = await this.prisma.leaveAttachment.findUniqueOrThrow({ where: { id: documentId }, select: { fileName: true, mimeType: true, data: true } });
    return { fileName: row.fileName, mimeType: row.mimeType, data: Buffer.from(row.data) };
  }

  async remove(user: AuthUser, documentId: string): Promise<void> {
    const doc = await this.prisma.leaveAttachment.findUnique({
      where: { id: documentId },
      select: { id: true, fileName: true, uploadedById: true, leaveRequest: { select: { id: true, employeeId: true, status: true } } },
    });
    if (!doc) throw AppError.notFound('Document not found');
    const hr = this.isHr(user);
    const ownPending = doc.leaveRequest.employeeId === user.employeeId && doc.uploadedById === user.userId && doc.leaveRequest.status === 'PENDING';
    if (!hr && !ownPending) {
      await this.leave.getFor(user, doc.leaveRequest.id).catch(() => {
        throw AppError.notFound('Document not found');
      });
      throw AppError.forbidden('ATTACHMENT_NOT_ALLOWED', 'This document can no longer be removed');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.leaveAttachment.delete({ where: { id: documentId } });
      await this.audit.record(tx, {
        actorUserId: user.userId, action: 'LEAVE_DOCUMENT_DELETE', entityType: 'LeaveRequest', entityId: doc.leaveRequest.id, ipAddress: user.ip,
        before: { documentId, fileName: doc.fileName },
      });
    }, TX_OPTIONS);
  }
}
