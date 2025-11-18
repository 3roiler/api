import passport from 'passport';
import { Strategy as GitHubStrategy, Profile as GitHubProfile } from 'passport-github2';
import type { VerifyCallback } from 'passport-oauth2';
import config from './index.js';
import type { GitHubAuthUser } from '../types/auth.js';

type GitHubPhoto = NonNullable<GitHubProfile['photos']>[number];

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj as Express.User);
});

const hasGitHubCredentials = Boolean(config.oauth.github.clientId && config.oauth.github.clientSecret);

if (hasGitHubCredentials) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: config.oauth.github.clientId,
        clientSecret: config.oauth.github.clientSecret,
        callbackURL: config.oauth.github.callbackUrl,
        scope: config.oauth.github.scope,
      },
      (accessToken: string, refreshToken: string, profile: GitHubProfile, done: VerifyCallback) => {
        try {
          const emails: NonNullable<GitHubProfile['emails']> = profile.emails ?? [];
          const primaryEmail = emails.find((email) => {
            if (!email) {
              return false;
            }

            if ('primary' in email) {
              return Boolean((email as { primary?: boolean }).primary);
            }

            return false;
          })?.value ?? null;
          const fallbackEmail = emails.length > 0 ? emails[0].value : null;
          const photos: NonNullable<GitHubProfile['photos']> = profile.photos ?? [];
          const primaryPhoto = photos.find((photo: GitHubPhoto) => Boolean(photo.value)) || null;
          const snapshot = (profile as { _json?: Record<string, unknown> })._json ?? {};

          const authUser: GitHubAuthUser = {
            provider: 'github',
            id: profile.id,
            username: profile.username || profile.displayName || profile.id,
            displayName: profile.displayName || profile.username || profile.id,
            email: primaryEmail || fallbackEmail || null,
            avatarUrl: primaryPhoto?.value ?? null,
            profileUrl: profile.profileUrl || null,
            accessToken,
            refreshToken: refreshToken || null,
            rawProfile: snapshot,
          };

          done(null, authUser);
        } catch (error) {
          done(error as Error);
        }
      }
    )
  );
} else {
  console.warn('GitHub OAuth credentials are missing. GitHub login is disabled until the environment variables are set.');
}
