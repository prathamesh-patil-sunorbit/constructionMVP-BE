import { AuditLog } from '../models/index.js';

export function audit(user, action, data = {}) {
  return AuditLog.create({
    user: user?._id,
    userName: user?.name || 'System',
    action,
    ...data,
  });
}
