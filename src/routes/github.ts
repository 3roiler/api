import { Router } from 'express';
import { config, user as userService } from '../services';
import auth from '../services/auth.js';
import AppError from '../services/error';

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
    id: string;
    login: string;
    name: string;
    email: string;
  };

  let existingUser = await userService.getUserByGithubId(githubUser.id);

  if (!existingUser) {
    existingUser = await userService.createUser({
      name: githubUser.login,
      displayName: githubUser.name,
      email: githubUser.email
    });

    await userService.updateGithub(existingUser.id, githubUser.id);
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