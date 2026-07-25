import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { createSession, requireLocalApiSession, verifyPassword, hashPassword } from '@/lib/auth';
import { passwordMeetsPolicy } from '@/lib/login-policy';

/** 修改密码 */
export async function POST(request: Request) {
  const auth = await requireLocalApiSession();
  if (!auth.ok) return auth.response;
  const session = auth.session;
  try {
    const { oldPassword, newPassword } = await request.json();
    if (!oldPassword || !newPassword) {
      return NextResponse.json({ error: '旧密码和新密码不能为空' }, { status: 400 });
    }
    if (!passwordMeetsPolicy(newPassword)) {
      return NextResponse.json({ error: '新密码至少 14 个字符' }, { status: 400 });
    }

    const user = await prisma.$transaction(async (tx) => {
      const candidate = await tx.user.findUnique({ where: { id: session.userId } });
      if (!candidate || !(await verifyPassword(oldPassword, candidate.password))) {
        return null;
      }
      const hash = await hashPassword(newPassword);
      return tx.user.update({
        where: { id: candidate.id },
        data: {
          password: hash,
          sessionVersion: { increment: 1 },
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    });
    if (!user) {
      return NextResponse.json({ error: '旧密码错误' }, { status: 400 });
    }

    await createSession({
      userId: user.id,
      username: user.username,
      sessionVersion: user.sessionVersion,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: '修改失败' }, { status: 500 });
  }
}
