export class AppError extends Error {
  statusCode: number;
  identifier: string;

  constructor(statusCode: number, identifier: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.identifier = identifier;

    Error.captureStackTrace(this, this.constructor);
  }
}

function badRequest(message: string, identifier: string = 'BAD_REQUEST') {
    return new AppError(400, identifier, message);
  }

function notFound(message: string, identifier: string = 'NOT_FOUND') {
    return new AppError(404, identifier, message);
  }

function internal(message: string, identifier: string = 'INTERNAL_SERVER_ERROR') {
    return new AppError(500, identifier, message);
  }

function serviceUnavailable(message: string, identifier: string = 'SERVICE_UNAVAILABLE') {
    return new AppError(503, identifier, message);
  }

export default {
  AppError,
  badRequest,
  notFound,
  internal,
  serviceUnavailable
};