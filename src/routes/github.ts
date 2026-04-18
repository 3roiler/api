import { Router } from 'express';
import { config, user as userService } from '../services/index.js';
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
  };
  const githubId = String(githubUser.id);
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
