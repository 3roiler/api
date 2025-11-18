export interface User {
  id: string;
  githubId: string | null;
  username: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Group {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Scope {
  id: string;
  key: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserAuthorization {
  user: User;
  groups: Group[];
  scopes: Scope[];
}