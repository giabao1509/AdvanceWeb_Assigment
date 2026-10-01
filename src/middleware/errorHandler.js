const { AppError } = require('../errors/AppError');

function fieldFromValidationError(error) {
  const path = error.path || error.instancePath || '';
  const parts = path.split(/[/.]/).filter(Boolean);
  const ignored = new Set(['body', 'query', 'path', 'params', 'headers']);
  const pathField = [...parts].reverse().find((part) => !ignored.has(part));
  if (pathField) return pathField;

  const quotedField = String(error.message || '').match(/['"]([^'"]+)['"]/);
  return quotedField ? quotedField[1] : 'request';
}

function validationDetails(error) {
  const source = Array.isArray(error.errors) && error.errors.length > 0
    ? error.errors
    : [error];

  return source.map((item) => ({
    field: fieldFromValidationError(item),
    issue: item.message || 'is invalid',
  }));
}

function errorHandler(error, req, res, _next) {
  if (error instanceof AppError) {
    return res.status(error.status).json({
      code: error.code,
      message: error.message,
      details: error.details,
      request_id: req.id,
    });
  }

  if (error.status === 400) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Request is invalid',
      details: validationDetails(error),
      request_id: req.id,
    });
  }

  req.log.error(
    { error_type: error.name || 'Error', request_id: req.id },
    'Unhandled request error',
  );
  return res.status(500).json({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Internal server error',
    details: [],
    request_id: req.id,
  });
}

module.exports = { errorHandler };
