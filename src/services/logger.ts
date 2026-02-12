import { Request, Response, NextFunction } from 'express';

const logger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  
  res.on('finish', () => {
    if (res.locals.skipLogging) {
      return;
    }

    const method = req.method;
    const url = req.originalUrl;
    const status = res.statusCode;
    const agent = req.headers['user-agent'] || '';
    const ip = req.ip;
    const duration = Date.now() - start;

    console.log(
      `[${new Date().toISOString()}] ${method} ${url} ${status} - ${duration}ms - ${agent} - ${ip}`
    );
  });
  
  next();
};

export default logger;