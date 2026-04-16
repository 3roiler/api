import jose from 'jose';
import config from './config';

interface OAuthToken {
    access_token: string;
    token_type: string;
    scope: string;
    error?: string;
    error_description?: string;
}

interface TwitchOAuthToken extends OAuthToken {
    refresh_token?: string;
    expires_in?: number;
}

class Auth {
    private readonly encoder = new TextEncoder();

    async exchangeGithub(code: string, state: string, clientId: string, clientSecret: string, callbackUrl: string) : Promise<OAuthToken> {
        const response = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                state,
                redirect_uri: callbackUrl
            })
        });

        if (!response.ok) {
            throw new Error('Failed to exchange code for access token');
        }

        const data = await response.json() as OAuthToken;

        if (data.error) {
            throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
        }

        return data;
    }

    async exchangeTwitch(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<TwitchOAuthToken> {
        const response = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri
            })
        });

        if (!response.ok) {
            throw new Error('Failed to exchange Twitch code for access token');
        }

        const data = await response.json() as TwitchOAuthToken;

        if (data.error) {
            throw new Error(`Twitch OAuth error: ${data.error_description || data.error}`);
        }

        return data;
    }

    async refreshTwitchToken(refreshToken: string, clientId: string, clientSecret: string): Promise<TwitchOAuthToken> {
        const response = await fetch('https://id.twitch.tv/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });

        if (!response.ok) {
            throw new Error('Failed to refresh Twitch token');
        }

        const data = await response.json() as TwitchOAuthToken;

        if (data.error) {
            throw new Error(`Twitch token refresh error: ${data.error_description || data.error}`);
        }

        return data;
    }

    async verifyToken(token: string, secret: string) {
        return await jose.jwtVerify(token, this.encoder.encode(secret));
    }

    generateToken(payload: jose.JWTPayload, secret: string, options?: jose.SignOptions) {
        const jwt = new jose.SignJWT(payload)
            .setProtectedHeader({
                alg: 'HS256',
                typ: 'JWT'
            })
            .setIssuedAt()
            .setIssuer(config.url)
            .setExpirationTime(config.jwtExpire / 60 / 60 / 1000 + 'h');

        const encoded = this.encoder.encode(secret);

        return jwt.sign(encoded, options);
    }
}

export default new Auth();