import { Router } from 'express';
import { config, user as userService, bootstrap } from '../services/index.js';
import auth from '../services/auth.js';
import AppError from '../services/error.js';

const router = Router();

async function getGithubUserInfo(accessToken: string) {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!response.ok) {
    throw new Error('Failed to fetch user info from GitHub');
  }

  return await response.json();
}

interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

/**
 * Falls back to the `/user/emails` endpoint when the `/user` response
 * returned `email: null` (happens when the user has their email set to
 * private on GitHub). Requires the `user:email` scope, which the frontend
 * already requests. Returns the primary verified email, or `null` if none
 * of the entries qualify.
 */
async function getPrimaryVerifiedEmail(accessToken: string): Promise<string | null> {
  const response = await fetch('https://api.github.com/user/emails', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!response.ok) {
    // A 404 / 403 here just means the token lacks user:email scope — treat
    // as "no email available" rather than failing the whole login.
    return null;
  }

  const emails = (await response.json()) as GithubEmail[];
  const primary = emails.find((e) => e.primary && e.verified);
  if (primary) return primary.email;
  const anyVerified = emails.find((e) => e.verified);
  return anyVerified?.email ?? null;
}

/**
 * True if `value` is an http(s) URL whose hostname is either
 * `avatars.githubusercontent.com` / any `*.githubusercontent.com`
 * subdomain, or `github.com`. Used to decide whether an existing
 * avatar is still "provider-managed" and may be overwritten by a
 * fresh OAuth sync.
 *
 * Parsing the URL (rather than substring-matching the raw text) is
 * what the CodeQL "Incomplete URL substring sanitization" rule is
 * after — arbitrary hosts can embed the marker in their path.
 */
function isGithubHostedAvatar(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'github.com' ||
      host === 'githubusercontent.com' ||
      host.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

router.post("/oauth", async (req, res, next) => {
  const { code, state } = req.body;

  if (typeof code !== 'string' || typeof state !== 'string') {
    return next(AppError.badRequest('Code and state are required and must be strings.'));
  }

  const redirectUri = req.headers.referer || '';
  const token = await auth.exchangeGithub(code, state, config.providers.github.clientId, config.providers.github.clientSecret, redirectUri);
  const response = await getGithubUserInfo(token.access_token);

  const githubUser = response as {
    id: string | number;
    login: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  };
  const githubId = String(githubUser.id);
  const avatarUrl = typeof githubUser.avatar_url === 'string' ? githubUser.avatar_url : null;
  // GitHub omits email from /user when the user set it to private. Fall
  // back to the /user/emails endpoint so cross-provider linking by email
  // and `ADMIN_EMAILS` bootstrap can actually find the user.
  const email = githubUser.email ?? (await getPrimaryVerifiedEmail(token.access_token));

  // 1. Fast path: user already linked via github_id.
  let existingUser = await userService.getUserByGithubId(githubId);

  // 2. Fall back to linking by email when a GitHub email is available and
  //    matches an existing user (e.g. they signed up with Twitch first).
  if (!existingUser && email) {
    const userByEmail = await userService.getUserByEmail(email);
    if (userByEmail) {
      await userService.updateGithub(userByEmail.id, githubId);
      existingUser = userByEmail;
    }
  }

  // 3. First time we see this user — create them.
  if (!existingUser) {
    existingUser = await userService.createUser({
      name: githubUser.login,
      displayName: githubUser.name,
      email
    });
    await userService.updateGithub(existingUser.id, githubId);
  } else if (email) {
    // Backfill email if it was missing before.
    await userService.setEmailIfMissing(existingUser.id, email);
    if (!existingUser.email) {
      existingUser = { ...existingUser, email };
    }
  }

  // Re-sync the avatar on every login so it stays fresh when the user
  // uploads a new GitHub avatar. Skipped if they have overridden it
  // manually — we detect that by parsing the stored URL and comparing
  // the hostname against GitHub's own hosts. Substring checks on the
  // raw URL are unsafe because attackers can embed the marker anywhere
  // (e.g. `https://evil.example/githubusercontent.com`).
  if (avatarUrl) {
    const currentAvatar = existingUser.avatarUrl;
    const userOverridden = currentAvatar ? !isGithubHostedAvatar(currentAvatar) : false;
    if (!userOverridden) {
      await userService.syncAvatarUrl(existingUser.id, avatarUrl);
      existingUser = { ...existingUser, avatarUrl };
    }
  }

  // Per-login seed: catches admins whose server booted before they existed,
  // or whose email was only just backfilled. Idempotent — safe to run every
  // login. Best-effort: a failure here shouldn't block the login.
  try {
    await bootstrap.seedAdminForUser(existingUser);
  } catch (err) {
    console.error('[github/oauth] seedAdminForUser failed:', err);
  }

  const jwtToken = await auth.generateToken({
    sub: existingUser.id,
    name: existingUser.name,
    permissions: await userService.getPermissions(existingUser.id)
  }, config.jwtSecret);

  return res.cookie('access_token', jwtToken, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    domain: config.url.replace(/^https?:\/\//, '').split(':')[0],
    maxAge: config.jwtExpire,
    path: config.prefix
  }).status(200).json(existingUser);
});

export default router;
