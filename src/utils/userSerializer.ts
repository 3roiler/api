import type { User } from '../models/index.js';

const BASIC_USER_FIELDS: Array<keyof User> = ['id', 'displayName', 'profileUrl', 'avatarUrl', 'createdAt'];
export const EXTENDED_USER_SCOPE = 'users:read';
export const EMAIL_USER_SCOPE = 'users:read.email';

export interface SerializeUserOptions {
  isSelf: boolean;
  scopes: string[];
}

export const serializeUser = (user: User, options: SerializeUserOptions) => {
  const result: Record<string, unknown> = {};

  for (const field of BASIC_USER_FIELDS) {
    result[field] = user[field];
  }

  if (options.isSelf || options.scopes.includes(EXTENDED_USER_SCOPE)) {
    result.username = user.username;
    result.githubId = user.githubId;
    result.updatedAt = user.updatedAt;
  }

  if (options.isSelf || options.scopes.includes(EMAIL_USER_SCOPE)) {
    result.email = user.email;
  }

  return result;
};
