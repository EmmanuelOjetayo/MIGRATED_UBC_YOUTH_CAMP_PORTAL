const jwt = require("jsonwebtoken");
require("dotenv").config({
  path: require("path").join(__dirname, "../.env"),
});

/**
 * CAMP JWT generator.
 *
 * Every CAMP token carries an `app: "CAMP"` claim. The CAMP auth
 * middleware rejects any token without it, which guarantees a GLS
 * token (issued by `Backend/` with its own secret) can never
 * authenticate against the CAMP API, and vice versa.
 *
 * Signed with CAMP_JWT_SECRET — independent of the GLS JWT secret.
 */
function genYCJWT(id, role = "user") {
  return jwt.sign(
    {
      id,
      role,
      type: "ubcyc",
      app: "CAMP",
    },
    process.env.CAMP_JWT_SECRET,
    {
      expiresIn: "30d",
    }
  );
}

/**
 * Builds the password-reset token used by the approved CAMP
 * token-link flow: POST /api/ycuser/reset-password/:token
 */
function genYCResetToken() {
  return require("crypto").randomBytes(32).toString("hex");
}

module.exports = genYCJWT;
module.exports.genYCJWT = genYCJWT;
module.exports.genYCResetToken = genYCResetToken;