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
  const email = githubUser.email;

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
