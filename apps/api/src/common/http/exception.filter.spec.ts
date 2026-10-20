import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiExceptionFilter } from './exception.filter';

function run(exception: unknown) {
  const res = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn() };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/x' }) }),
  };
  new ApiExceptionFilter().catch(exception, host as never);
  return { status: res.status.mock.calls[0][0] as number, body: res.json.mock.calls[0][0] };
}

describe('ApiExceptionFilter', () => {
  it('answers P2002 with a bare CONFLICT and logs the constraint server-side only', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on users_username_key', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['username'] },
    });
    const { status, body } = run(err);
    expect(status).toBe(409);
    expect(body.error).toEqual({ code: 'CONFLICT', message: 'A record with these values already exists' });
    expect(JSON.stringify(body)).not.toMatch(/username/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('username'));
    warn.mockRestore();
  });

  it('never echoes body-parser messages', () => {
    const err = Object.assign(new Error('Unexpected token o in JSON at position 3'), { status: 400, type: 'entity.parse.failed' });
    const { status, body } = run(err);
    expect(status).toBe(400);
    expect(body.error.message).toBe('Malformed JSON body');
  });
});
