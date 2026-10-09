const errorHandler = (err, req, res, next) => {
  // 1. Delegate to default handler if headers are already sent
  if (res.headersSent) {
    return next(err);
  }

  // 2. Determine status code (check error object first, then res.statusCode)
  const statusCode =
    err.statusCode ||
    err.status ||
    (res.statusCode !== 200 ? res.statusCode : 500);

  // 3. Send response
  res.status(statusCode).json({
    message: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV !== "production" && { stack: err.stack }),
  });
};

module.exports = errorHandler;