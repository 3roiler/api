import { Router } from 'express';
import { config, user as userService } from '../services';
import auth from '../services/auth.js';
import AppError from '../services/error';
import system from '../services/system.js';

const router = Router();

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

async function getTwitchUserInfo(accessToken: string, clientId: string) {
  const response = await fetch(`${TWITCH_API_BASE}/users`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': clientId
    }
  });

  if (!response.ok) {
    throw new Error('Failed to fetch user info from Twitch');
  }

  const data = await response.json() as { data: Array<{ id: string; login: string; display_name: string; email?: string }> };
  return data.data[0];
}

/**
 * POST /api/twitch/oauth
 * Exchange Twitch auth code for token, create/link user
 */
router.post('/oauth', async (req, res, next) => {
  const { code, redirect_uri } = req.body;

  if (typeof code !== 'string') {
    return next(AppError.badRequest('Code is required and must be a string.'));
  }

  const callbackUrl = redirect_uri || req.headers.referer || '';
  const { clientId, clientSecret } = config.providers.twitch;

  const token = await auth.exchangeTwitch(code, clientId, clientSecret, callbackUrl);
  const twitchUser = await getTwitchUserInfo(token.access_token, clientId);
  const email = twitchUser.email || null;

  // 1. Fast path: user already linked via twitch_id.
  let existingUser = await userService.getUserByTwitchId(twitchUser.id);

  // 2. Fall back to linking by email when Twitch exposed one (requires
  //    the user:read:email scope) and it matches an existing user.
  if (!existingUser && email) {
    const userByEmail = await userService.getUserByEmail(email);
    if (userByEmail) {
      await userService.updateTwitch(userByEmail.id, twitchUser.id);
      existingUser = userByEmail;
    }
  }

  // 3. First time we see this user — create them.
  if (!existingUser) {
    existingUser = await userService.createUser({
      name: twitchUser.login,
      displayName: twitchUser.display_name,
      email
    });
    await userService.updateTwitch(existingUser.id, twitchUser.id);
  } else if (email) {
    // Backfill email if it was missing before.
    await userService.setEmailIfMissing(existingUser.id, email);
  }

  await userService.saveTwitchToken(
    existingUser.id,
    twitchUser.id,
    twitchUser.login,
    token.access_token,
    token.refresh_token || '',
    token.scope,
    token.expires_in || 3600
  );

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
  }).status(200).json({
    user: existingUser,
    twitch: {
      login: twitchUser.login,
      displayName: twitchUser.display_name
    }
  });
});

/**
 * GET /api/twitch/stream/:channel
 * Get stream info for a channel (public, no auth needed)
 */
router.get('/stream/:channel', async (req, res, next) => {
  const { channel } = req.params;
  const { clientId, clientSecret } = config.providers.twitch;

  // Get app access token
  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    })
  });

  if (!tokenRes.ok) {
    return next(AppError.serviceUnavailable('Could not authenticate with Twitch'));
  }

  const appToken = await tokenRes.json() as { access_token: string };

  const [streamRes, userRes] = await Promise.all([
    fetch(`${TWITCH_API_BASE}/streams?user_login=${encodeURIComponent(channel)}`, {
      headers: { 'Authorization': `Bearer ${appToken.access_token}`, 'Client-Id': clientId }
    }),
    fetch(`${TWITCH_API_BASE}/users?login=${encodeURIComponent(channel)}`, {
      headers: { 'Authorization': `Bearer ${appToken.access_token}`, 'Client-Id': clientId }
    })
  ]);

  const streamData = await streamRes.json() as { data: Array<{ viewer_count: number; game_name: string; title: string; started_at: string; type: string }> };
  const userData = await userRes.json() as { data: Array<{ id: string; login: string; display_name: string; profile_image_url: string; description: string }> };

  const stream = streamData.data[0] || null;
  const user = userData.data[0] || null;

  return res.json({
    live: !!stream && stream.type === 'live',
    viewer_count: stream?.viewer_count || 0,
    game: stream?.game_name || null,
    title: stream?.title || null,
    started_at: stream?.started_at || null,
    channel: user ? {
      id: user.id,
      login: user.login,
      displayName: user.display_name,
      avatar: user.profile_image_url,
      description: user.description
    } : null
  });
});

/**
 * POST /api/twitch/chat/send
 * Send a chat message (requires auth + twitch token)
 */
router.post('/chat/send', system.authHandler, async (req, res, next) => {
  const { message, channel_id } = req.body;
  const userId = req.userId!;

  if (typeof message !== 'string' || !message.trim()) {
    return next(AppError.badRequest('Message is required.'));
  }

  if (typeof channel_id !== 'string') {
    return next(AppError.badRequest('channel_id is required.'));
  }

  const twitchToken = await userService.getTwitchToken(userId);
  if (!twitchToken) {
    return next(AppError.unauthorized('No Twitch account linked. Please login with Twitch first.'));
  }

  // Refresh token if expired
  let accessToken = twitchToken.accessToken;
  if (new Date(twitchToken.expiresAt) <= new Date()) {
    const { clientId, clientSecret } = config.providers.twitch;
    const refreshed = await auth.refreshTwitchToken(twitchToken.refreshToken, clientId, clientSecret);
    accessToken = refreshed.access_token;

    await userService.saveTwitchToken(
      userId,
      twitchToken.twitchUserId,
      twitchToken.twitchLogin,
      refreshed.access_token,
      refreshed.refresh_token || twitchToken.refreshToken,
      refreshed.scope,
      refreshed.expires_in || 3600
    );
  }

  const { clientId } = config.providers.twitch;

  const chatRes = await fetch(`${TWITCH_API_BASE}/chat/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': clientId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      broadcaster_id: channel_id,
      sender_id: twitchToken.twitchUserId,
      message: message.trim()
    })
  });

  if (!chatRes.ok) {
    const err = await chatRes.json().catch(() => ({}));
    return next(AppError.badRequest(`Twitch chat error: ${(err as { message?: string }).message || chatRes.statusText}`));
  }

  const result = await chatRes.json();
  return res.json(result);
});

/**
 * GET /api/twitch/me
 * Get current user's Twitch info (requires auth)
 */
router.get('/me', system.authHandler, async (req, res, _next) => {
  const userId = req.userId!;
  const twitchToken = await userService.getTwitchToken(userId);

  if (!twitchToken) {
    return res.json({ linked: false });
  }

  return res.json({
    linked: true,
    twitchUserId: twitchToken.twitchUserId,
    twitchLogin: twitchToken.twitchLogin,
    expiresAt: twitchToken.expiresAt
  });
});

export default router;
