import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { createSession, verifyPassword } from '@/lib/auth';
import { isAccountLocked, lockUntilAfterFailure } from '@/lib/login-policy';

const LOGIN_FAILURE_MESSAGE = '用户名或密码错误';
const DUMMY_PASSWORD_HASH = '$2b$10$C6UzMDM.H6dfI/f/IKcEe.4iMHLhMhqMNmVCxK0YkD2EHui1e';

/** 登录 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) {
      return NextResponse.json({ error: '用户名和密码不能为空' }, { status: 400 });
    }

    const user = await prisma.$transaction(async (tx) => {
      const candidate = await tx.user.findUnique({ where: { username } });
      if (!candidate) {
        await verifyPassword(password, DUMMY_PASSWORD_HASH);
        return null;
      }

      const now = new Date();
      if (isAccountLocked(candidate.lockedUntil, now)) return null;

      const ok = await verifyPassword(password, candidate.password);
      if (!ok) {
        const lockExpired = candidate.lockedUntil !== null;
        const failed = await tx.user.update({
          where: { id: candidate.id },
          data: lockExpired
            ? { failedLoginAttempts: 1, lockedUntil: null }
            : { failedLoginAttempts: { increment: 1 } },
        });
        const lockedUntil = lockUntilAfterFailure(failed.failedLoginAttempts, now);
        if (lockedUntil) {
          await tx.user.update({
            where: { id: candidate.id },
            data: { lockedUntil },
          });
        }
        return null;
      }

      return tx.user.update({
        where: { id: candidate.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    });

    if (!user) {
      return NextResponse.json({ error: LOGIN_FAILURE_MESSAGE }, { status: 401 });
    }

    await createSession({
      userId: user.id,
      username: user.username,
      sessionVersion: user.sessionVersion,
    });
    return NextResponse.json({ ok: true, username: user.username });
  } catch {
    return NextResponse.json({ error: '登录失败' }, { status: 500 });
  }
}
