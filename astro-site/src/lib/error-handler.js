/**
 * グローバルエラーハンドリングユーティリティ
 */

export class AppError extends Error {
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.name = this.constructor.name;

        Error.captureStackTrace(this, this.constructor);
    }
}

export class ValidationError extends AppError {
    constructor(message, field = null) {
        super(message, 400);
        this.field = field;
        this.name = 'ValidationError';
    }
}

export class AuthenticationError extends AppError {
    constructor(message = 'Authentication failed') {
        super(message, 401);
        this.name = 'AuthenticationError';
    }
}

export class AuthorizationError extends AppError {
    constructor(message = 'Access denied') {
        super(message, 403);
        this.name = 'AuthorizationError';
    }
}

export class NotFoundError extends AppError {
    constructor(message = 'Resource not found') {
        super(message, 404);
        this.name = 'NotFoundError';
    }
}

export class StripeError extends AppError {
    constructor(message, stripeCode = null) {
        super(message, 500);
        this.stripeCode = stripeCode;
        this.name = 'StripeError';
    }
}

export class DatabaseError extends AppError {
    constructor(message) {
        super(message, 500);
        this.name = 'DatabaseError';
    }
}

/**
 * APIレスポンス用のエラーハンドラー
 */
export function handleAPIError(error, context = {}) {
    console.error('API Error:', {
        message: error.message,
        stack: error.stack,
        context,
        timestamp: new Date().toISOString(),
    });

    // 本番環境では詳細なエラー情報を隠す
    const isDevelopment = import.meta.env.MODE === 'development';
    
    let statusCode = 500;
    let message = 'Internal Server Error';
    
    if (error instanceof AppError) {
        statusCode = error.statusCode;
        message = error.message;
    } else if (error.name === 'ValidationError') {
        statusCode = 400;
        message = error.message;
    } else if (error.name === 'SyntaxError' && error.message.includes('JSON')) {
        statusCode = 400;
        message = 'Invalid JSON format in request body';
    } else if (error.code === 'ECONNREFUSED') {
        statusCode = 503;
        message = 'Service temporarily unavailable';
    }

    const errorResponse = {
        error: message,
        statusCode,
        timestamp: new Date().toISOString(),
    };

    // 開発環境では詳細な情報を追加
    if (isDevelopment) {
        errorResponse.details = {
            stack: error.stack,
            name: error.name,
            context,
        };
    }

    return new Response(
        JSON.stringify(errorResponse),
        {
            status: statusCode,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        }
    );
}

/**
 * 非同期処理用のエラーハンドリングラッパー
 */
export function asyncHandler(fn) {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            return handleAPIError(error);
        }
    };
}

/**
 * Supabaseエラーをアプリケーションエラーに変換
 */
export function handleSupabaseError(error) {
    if (!error) return null;

    if (error.code === 'PGRST116') {
        throw new NotFoundError('Record not found');
    }
    
    if (error.code === '23505') {
        throw new ValidationError('Duplicate entry');
    }
    
    if (error.code === '42501') {
        throw new AuthorizationError('Database access denied');
    }

    throw new DatabaseError(`Database error: ${error.message}`);
}

/**
 * Stripeエラーをアプリケーションエラーに変換
 */
export function handleStripeError(error) {
    if (!error) return null;

    const { type, code, message } = error;
    
    switch (type) {
        case 'StripeCardError':
            throw new ValidationError(`Card error: ${message}`);
            
        case 'StripeRateLimitError':
            throw new AppError('Too many requests, please try again later', 429);
            
        case 'StripeInvalidRequestError':
            throw new ValidationError(`Invalid request: ${message}`);
            
        case 'StripeAPIError':
            throw new StripeError('Payment service error', code);
            
        case 'StripeConnectionError':
            throw new AppError('Payment service unavailable', 503);
            
        case 'StripeAuthenticationError':
            throw new AppError('Payment configuration error', 500);
            
        default:
            throw new StripeError(`Payment error: ${message}`, code);
    }
}

/**
 * リクエストボディの安全な解析
 */
export async function parseRequestBody(request) {
    try {
        const text = await request.text();
        if (!text.trim()) {
            throw new ValidationError('Request body is required');
        }
        return JSON.parse(text);
    } catch (error) {
        if (error instanceof ValidationError) {
            throw error;
        }
        throw new ValidationError('Invalid JSON format in request body');
    }
}

/**
 * APIキー認証チェック
 */
export function validateAPIKey(request, requiredKey) {
    const authHeader = request.headers.get('authorization');
    
    if (!authHeader) {
        throw new AuthenticationError('Authorization header is required');
    }
    
    if (!authHeader.includes(requiredKey)) {
        throw new AuthenticationError('Invalid API key');
    }
}

/**
 * レート制限チェック（簡易版）
 */
const rateLimitMap = new Map();

export function checkRateLimit(identifier, limit = 100, windowMs = 60000) {
    const now = Date.now();
    const windowStart = now - windowMs;
    
    if (!rateLimitMap.has(identifier)) {
        rateLimitMap.set(identifier, []);
    }
    
    const requests = rateLimitMap.get(identifier);
    
    // 古いリクエストを削除
    const recentRequests = requests.filter(time => time > windowStart);
    
    if (recentRequests.length >= limit) {
        throw new AppError('Rate limit exceeded', 429);
    }
    
    recentRequests.push(now);
    rateLimitMap.set(identifier, recentRequests);
}

/**
 * ログ出力用のユーティリティ
 */
export function logError(error, context = {}) {
    const logData = {
        timestamp: new Date().toISOString(),
        error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
            statusCode: error.statusCode,
        },
        context,
    };
    
    console.error('Application Error:', JSON.stringify(logData, null, 2));
}