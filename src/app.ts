import express, { Application, Request, Response } from 'express';
import dotenv from 'dotenv';
import config from './config';
import routes from './routes';
import { logger, notFound, errorHandler } from './middleware';
dotenv.config();

const app: Application = express();
const PORT = config.port;

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
