import { Response } from 'express';
import { CACHE_MAX_AGE_SECONDS } from '../config';

/**
 * The standard /v1 envelope: { status, code, data?, error? }.
 * Business outcomes are HTTP 200 with a code; only server failures use HTTP 500.
 */

export const ResponseCode = {
    SUCCESS: 20000,
    NO_DATA: 20400,
    INVALID_INPUT: 40000,
    NOT_FOUND: 40400,
    SERVER_ERROR: 50000,
} as const;

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const NO_STORE = 'no-store';
const PUBLIC_CACHE = `public, max-age=${CACHE_MAX_AGE_SECONDS}`;

export interface SuccessBody<T> {
    status: 'ok';
    code: number;
    data?: T;
}

export interface ErrorBody {
    status: 'error';
    code: number;
    error: { message: string };
}

/** isCacheable: false for answers that must always be fresh, such as the health check. */
export function sendSuccess<T>(res: Response, data: T, isCacheable = true): void {
    const body: SuccessBody<T> = { status: 'ok', code: ResponseCode.SUCCESS, data };
    res.set('Cache-Control', isCacheable ? PUBLIC_CACHE : NO_STORE).status(HTTP_OK).json(body);
}

/** Nothing matched; data is optional, e.g. an empty list. */
export function sendNoData<T>(res: Response, data?: T): void {
    const body: SuccessBody<T> = { status: 'ok', code: ResponseCode.NO_DATA };
    if(data !== undefined) body.data = data;
    res.set('Cache-Control', NO_STORE).status(HTTP_OK).json(body);
}

function sendError(res: Response, httpStatus: number, code: number, message: string): void {
    const body: ErrorBody = { status: 'error', code, error: { message } };
    res.set('Cache-Control', NO_STORE).status(httpStatus).json(body);
}

export function sendInvalidInput(res: Response, message: string): void {
    sendError(res, HTTP_OK, ResponseCode.INVALID_INPUT, message);
}

export function sendNotFound(res: Response): void {
    sendError(res, HTTP_NOT_FOUND, ResponseCode.NOT_FOUND, 'Not found');
}

/** The message stays generic so that internal details do not leak; the cause goes to the log. */
export function sendServerError(res: Response): void {
    sendError(res, HTTP_SERVER_ERROR, ResponseCode.SERVER_ERROR, 'Internal server error');
}
