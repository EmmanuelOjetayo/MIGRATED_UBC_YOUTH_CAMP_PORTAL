const jwt = require("jsonwebtoken");

const YCUser = require("../Model/YCUser");

require("dotenv").config({
  path: require("path").join(__dirname, "../.env"),
});

/**
 * CAMP authentication middleware.
 *
 * Independent of the GLS `Backend/Middleware/AuthMiddleware.js` —
 * no GLS file is imported. Two isolation guarantees:
 *
 *  1. Signature is verified against CAMP_JWT_SECRET only.
 *  2. The token must carry `app: "CAMP"`.
 *
 * Together these mean a GLS JWT cannot be replayed against the CAMP
 * API even though both applications share one MongoDB cluster.
 */
const ycAuth = async (req, res, next) => {
  try {
    if (
      !req.headers.authorization ||
      !req.headers.authorization.startsWith("Bearer ")
    ) {
      return res.status(401).json({
        success: false,
        message: "Authorization token required",
      });
    }

    const token = req.headers.authorization.split(" ")[1];

    const decoded = jwt.verify(token, process.env.CAMP_JWT_SECRET);

    // ── CAMP TOKEN SCOPE ENFORCEMENT ──
    if (decoded.app !== "CAMP") {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    if (!decoded.id) {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    const user = await YCUser.findById(decoded.id).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    req.user = user;
    req.user.type = decoded.type;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Token invalid or expired",
    });
  }
};

module.exports = ycAuth;