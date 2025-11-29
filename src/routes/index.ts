import { Router } from 'express';
import { system, config, user as userService } from '../services';
import user from './user.js';
import auth from '../services/auth.js';
import AppError from '../services/error';

const router = Router();

router.get('/', async (_, res) => {
  res.status(200).send('running');
});

router.get('/health', async (_, res) => {
  const healthState = await system.getHealthState();
  res.status(healthState.ready ? 200 : 503).json(healthState);
});

router.post('/login', system.loginHandler);
router.post('/register', system.registerHandler);

router.post("/auth/github", async (req, res, next) => {
  var { code, state } = req.body;

  if (typeof code !== 'string' || typeof state !== 'string') {
    return next(AppError.badRequest('Code and state are required and must be strings.'));
  }

  var redirectUri = req.headers.referer || '';

  try {
    var token = await auth.exchangeGithub(code, state, config.providers.github.clientId, config.providers.github.clientSecret, redirectUri);
  } catch (err) {
    console.error('Error exchanging code for access token:', err);
    return next(AppError.unauthorized('Failed to exchange code for access token.'));
  }

  try {
    var response = await getGithubUserInfo(token.access_token);

    var githubUser = response as {
      id: string;
      login: string;
      name: string;
      email: string;
    };

    var existingUser = await userService.getUserByGithubId(githubUser.id);

    if (!existingUser) {
      existingUser = await userService.createUser({
        name: githubUser.login,
        displayName: githubUser.name,
        email: githubUser.email
      });

      await userService.updateGithub(existingUser.id, githubUser.id);
    }
  } catch (err) {
    return next(AppError.unauthorized('Failed to fetch user info from GitHub.'));
  }

  var jwtToken = await auth.generateToken({
    sub: existingUser.id,
    name: existingUser.name
  }, config.jwtSecret);

  return res.cookie('access_token', jwtToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    domain: config.url.replace(/^https?:\/\//, '').split(':')[0],
    maxAge: config.jwtExpire,
    path: config.prefix
  }).status(200).json(existingUser);
});

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

router.use('/user', system.authHandler, user);

export default router;