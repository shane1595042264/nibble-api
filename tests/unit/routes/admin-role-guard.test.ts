import { describe, it, expect } from 'vitest';
import { roleDemotionGuardError } from '../../../src/routes/admin.js';

const admin = '11111111-1111-4111-8111-111111111111';
const otherAdmin = '22222222-2222-4222-8222-222222222222';

describe('roleDemotionGuardError', () => {
  it('allows promoting a user to admin', () => {
    expect(
      roleDemotionGuardError({
        role: 'admin',
        targetId: otherAdmin,
        targetRole: 'user',
        callerId: admin,
        adminCount: 1,
      }),
    ).toBeNull();
  });

  it('allows a no-op write on a non-admin (role stays user)', () => {
    expect(
      roleDemotionGuardError({
        role: 'user',
        targetId: otherAdmin,
        targetRole: 'user',
        callerId: admin,
        adminCount: 2,
      }),
    ).toBeNull();
  });

  it('blocks an admin demoting their own account', () => {
    expect(
      roleDemotionGuardError({
        role: 'user',
        targetId: admin,
        targetRole: 'admin',
        callerId: admin,
        adminCount: 5,
      }),
    ).toBe('You cannot demote your own admin account');
  });

  it('blocks demoting the last remaining admin', () => {
    expect(
      roleDemotionGuardError({
        role: 'user',
        targetId: otherAdmin,
        targetRole: 'admin',
        callerId: admin,
        adminCount: 1,
      }),
    ).toBe('Cannot demote the last remaining admin');
  });

  it('allows demoting another admin when more than one remains', () => {
    expect(
      roleDemotionGuardError({
        role: 'user',
        targetId: otherAdmin,
        targetRole: 'admin',
        callerId: admin,
        adminCount: 2,
      }),
    ).toBeNull();
  });

  it('self-demotion is rejected even if other admins remain', () => {
    expect(
      roleDemotionGuardError({
        role: 'user',
        targetId: admin,
        targetRole: 'admin',
        callerId: admin,
        adminCount: 3,
      }),
    ).toBe('You cannot demote your own admin account');
  });
});
