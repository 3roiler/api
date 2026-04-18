import { Request, Response, NextFunction } from 'express';
import metricsService, { isValidWindow, type MetricWindow } from '../services/metrics.js';
import AppError from '../services/error.js';

/**
 * `/admin/metrics/*` HTTP entrypoints. Every handler is thin — pulls the
 * window param (optional), lets the service do the DO-API + Redis dance,
 * and forwards the raw JSON to the caller. AppError instances bubble up to
 * the global errorHandler untouched so the frontend gets the same
 * `{ identifier, message }` shape it already knows how to display.
 */

const DEFAULT_WINDOW: MetricWindow = '1h';

function parseWindow(req: Request, next: NextFunction): MetricWindow | null {
  const raw = typeof req.query.window === 'string' ? req.query.window : DEFAULT_WINDOW;
  if (!isValidWindow(raw)) {
    next(AppError.badRequest(`Unsupported window: ${raw}. Expected 1h, 6h, or 24h.`, 'BAD_METRICS_WINDOW'));
    return null;
  }
  return raw;
}

const getStatus = async (_req: Request, res: Response) => {
  const status = await metricsService.getStatus();
  res.status(200).json(status);
};

const getAppSummary = async (_req: Request, res: Response) => {
  const data = await metricsService.getAppSummary();
  res.status(200).json(data);
};

const getDatabaseSummary = async (_req: Request, res: Response) => {
  const data = await metricsService.getDatabaseSummary();
  res.status(200).json(data);
};

const getAppCpu = async (req: Request, res: Response, next: NextFunction) => {
  const window = parseWindow(req, next);
  if (!window) return;
  const data = await metricsService.getAppMetric('cpu_percentage', window);
  res.status(200).json(data);
};

const getAppMemory = async (req: Request, res: Response, next: NextFunction) => {
  const window = parseWindow(req, next);
  if (!window) return;
  const data = await metricsService.getAppMetric('memory_percentage', window);
  res.status(200).json(data);
};

const getDatabaseCpu = async (req: Request, res: Response, next: NextFunction) => {
  const window = parseWindow(req, next);
  if (!window) return;
  const data = await metricsService.getDatabaseMetric('cpu', window);
  res.status(200).json(data);
};

const getDatabaseMemory = async (req: Request, res: Response, next: NextFunction) => {
  const window = parseWindow(req, next);
  if (!window) return;
  const data = await metricsService.getDatabaseMetric('memory', window);
  res.status(200).json(data);
};

const getDatabaseDisk = async (req: Request, res: Response, next: NextFunction) => {
  const window = parseWindow(req, next);
  if (!window) return;
  const data = await metricsService.getDatabaseMetric('disk', window);
  res.status(200).json(data);
};

export default {
  getStatus,
  getAppSummary,
  getDatabaseSummary,
  getAppCpu,
  getAppMemory,
  getDatabaseCpu,
  getDatabaseMemory,
  getDatabaseDisk
};
