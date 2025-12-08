import jose from 'jose';
import config from './config';

 class GithubToken{
    access_token: string;
    token_type: string;
    scope: string;
    error: string | undefined;
    error_description: string | undefined;    

    constructor(access_token: string, token_type: string, scope: string, error?: string, error_description?: string){
        this.error = error;
        this.error_description = error_description;
        this.access_token = access_token;
        this.token_type = token_type;
        this.scope = scope;
    }
}

class Auth {
    private readonly encoder = new TextEncoder();

    async exchangeGithub(code: string, state: string, clientId: string, clientSecret: string, callbackUrl: string) : Promise<GithubToken> {
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

        const data = await response.json() as GithubToken;

        if (data.error) {
            throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
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