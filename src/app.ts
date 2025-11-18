import express, { Application, Request, Response } from 'express';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import passport from 'passport';
import config from './config/index.js';
import routes from './routes/index.js';
import { authenticate, logger, notFound, errorHandler } from './middleware/index.js';
import './config/passport.js';

dotenv.config();

const app: Application = express();
const PORT = config.port;
const useSecureCookies = config.session.secureCookie ?? config.isProduction;
const publicApiPaths = ['/auth', '/health', '/callback'];

if (useSecureCookies) {
  app.set('trust proxy', 1); // allow secure cookies behind proxies
}

app.use(cookieParser());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    name: config.session.cookieName,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: useSecureCookies,
      sameSite: 'lax',
      domain: config.session.cookieDomain,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logger);

app.use((req: Request, res: Response, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  
  next();
});

app.get('/', (_: Request, res: Response) => {
  res.redirect('https://broiler.dev/');
});

app.use(config.apiPrefix, authenticate({ publicPaths: publicApiPaths }));
app.use(config.apiPrefix, routes);

app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════╗
  ║   Environment: ${config.nodeEnv.padEnd(23)}║
  ║   Port: ${PORT.toString().padEnd(30)}║
  ║   API Prefix: ${config.apiPrefix.padEnd(24)}║
  ╚════════════════════════════════════════╝
  `);
});

process.on('unhandledRejection', (err: Error) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...');
  console.error(err.name, err.message);
  process.exit(1);
});

export default app;
