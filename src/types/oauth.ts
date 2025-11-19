export interface OAuthProviderConfig {
  key: string;
  displayName: string;
  strategyName: string;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scope: string[];
  successRedirect?: string;
  failureRedirect?: string;
  defaultRedirect?: string;
  allowedRedirectOrigins: string[];
  defaultRedirectOrigin?: string;
  stateMaxAgeMs: number;
  baseRedirectUrl: string;
}

export interface OAuthConfig {
  providers: Record<string, OAuthProviderConfig>;
  defaultProvider?: string;
}
