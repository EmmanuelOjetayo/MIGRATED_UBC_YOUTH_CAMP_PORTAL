const joi = require("joi");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

const YCUser = require("../Model/YCUser");
const YCPayment = require("../Model/YCPayment");
const genYCJWT = require("../utils/genYCJWT");
const {
  sendResetPasswordMail,
  sendMigrationNoticeMail,
} = require("../utils/sendYCMail");

// ─────────────────────────────────────────────────────────────
// CAMP CAMPER CONFIG
// ─────────────────────────────────────────────────────────────

const TARGET_FEE = Number(process.env.CAMP_TARGET_FEE) || 5000;

// ─────────────────────────────────────────────────────────────
// 1. SIGN UP
// ─────────────────────────────────────────────────────────────

// CAMP always sends `type: "ubcyc"` on auth calls, so unknown keys
// are permitted while the declared fields stay strictly validated.
const signUpSchema = joi.object({
  name: joi.string().trim().min(2).max(100),
  email: joi.string().email().required(),
  password: joi.string().min(6).max(100).required(),
  phone: joi.string().pattern(/^[0-9]{10,15}$/),
  gender: joi.valid("Male", "Female", "M", "F"),
}).unknown(true);

const SignUp = async (req, res, next) => {
  try {
    const { error, value } = signUpSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const { name, email, password, phone, gender } = value;
    const normalizedEmail = String(email).toLowerCase().trim();

    const existing = await YCUser.findOne({ email: normalizedEmail });

    if (existing) {
      const err = new Error("Email already registered");
      err.statusCode = 409;
      throw err;
    }

    const hashedPassword = await bcrypt.hash(password, 13);

    const newUser = await YCUser.create({
      name,
      email: normalizedEmail,
      password: hashedPassword,
      phone,
      gender,
      role: "user",
      type: "ubcyc",
      amount_paid: 0,
      status: "pending",
    });

    if (!newUser) {
      const err = new Error("Error in creating account");
      err.statusCode = 400;
      throw err;
    }

    res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: { id: newUser._id, role: newUser.role },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// 2. LOGIN
// ─────────────────────────────────────────────────────────────

const loginSchema = joi.object({
  email: joi.string().email().required(),
  password: joi.string().min(6).max(100).required(),
}).unknown(true);

const Login = async (req, res, next) => {
  try {
    const { error, value } = loginSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const normalizedEmail = String(value.email).toLowerCase().trim();

    const user = await YCUser.findOne({ email: normalizedEmail });

    if (!user) {
      const err = new Error(
        "Invalid credentials, Please check your credentials"
      );
      err.statusCode = 401;
      throw err;
    }

    // A camper migrated from Appwrite has no transferable password hash.
    if (!user.password) {
      const err = new Error(
        "Your account was migrated to our new platform. Please use 'Forgot Password' to create a new password."
      );
      err.statusCode = 401;
      throw err;
    }

    const checkPassword = await bcrypt.compare(value.password, user.password);

    if (!checkPassword) {
      const err = new Error(
        "Invalid credentials, Please check your credentials"
      );
      err.statusCode = 401;
      throw err;
    }

    res.status(200).json({
      success: true,
      message: "Login Successfully",
      user: {
        id: user._id,
        role: user.role,
        token: genYCJWT(user._id, user.role),
      },
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// 3. FETCH CAMPER DATA  (GET /me)
// ─────────────────────────────────────────────────────────────

const FetchYCUserData = async (req, res, next) => {
  try {
    const userData = await YCUser.findById(req.user._id).select("-password");

    if (!userData) {
      const err = new Error("Camper not found");
      err.statusCode = 404;
      throw err;
    }

    const payRecords = await YCPayment.find({ camperId: userData._id }).sort({
      createdAt: -1,
    });

    res.status(200).json({
      success: true,
      camper: userData,
      user: userData,
      payments: payRecords,
      targetFee: TARGET_FEE,
    });
  } catch (error) {
    next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// 4. FORGOT PASSWORD  →  emails a token link
//
// Legacy Appwrite-migrated campers (no password hash) automatically
// receive the friendly "we upgraded our platform" notice instead.
// ─────────────────────────────────────────────────────────────

const forgotPasswordSchema = joi.object({
  email: joi.string().email().required(),
}).unknown(true);

const ForgotPassword = async (req, res, next) => {
  try {
    const { error, value } = forgotPasswordSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    const normalizedEmail = String(value.email).toLowerCase().trim();

    const user = await YCUser.findOne({ email: normalizedEmail });

    // Always return the same generic message to prevent user enumeration.
    if (!user) {
      return res.status(200).json({
        success: true,
        message: "If an account exists for that email, a reset link has been sent.",
      });
    }

    // The raw token is emailed; only its SHA-256 hash is stored, so a
    // database leak cannot expose a live reset link.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(rawToken)
      .digest("hex");

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    await user.save();

    const frontendUrl =
      process.env.CAMP_FRONTEND_URL || "http://localhost:5173";
    const resetLink = `${frontendUrl}/reset-password/${rawToken}`;

    const isMigratedCamper = !user.password;

const sent = isMigratedCamper
  ? await sendMigrationNoticeMail({
      email: user.email,
      name: user.name,
      resetLink,
    })
  : await sendResetPasswordMail({
      email: user.email,
      name: user.name,
      resetLink,
    });

    if (!sent) {
      return res.status(500).json({
        success: false,
        message: "Failed to send password reset email",
      });
    }

    return res.status(200).json({
      success: true,
      message: "If an account exists for that email, a reset link has been sent.",
    });
  } catch (error) {
    return next(error);
  }
};

// ─────────────────────────────────────────────────────────────
// 5. RESET PASSWORD  (approved token-link flow)
//    POST /api/ycuser/reset-password/:token
// ─────────────────────────────────────────────────────────────

const resetPasswordSchema = joi.object({
  password: joi.string().min(6).max(100).required(),
}).unknown(true);

const ResetPassword = async (req, res, next) => {
  try {
    const { token } = req.params;

    const { error, value } = resetPasswordSchema.validate(req.body, {
      abortEarly: false,
    });

    if (error) {
      const err = new Error(error.details[0].message);
      err.statusCode = 400;
      throw err;
    }

    if (!token) {
      const err = new Error("Reset token is required");
      err.statusCode = 400;
      throw err;
    }

    const hashedToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const user = await YCUser.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      const err = new Error(
        "This password reset link is invalid or has expired"
      );
      err.statusCode = 400;
      throw err;
    }

    user.password = await bcrypt.hash(value.password, 13);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successfully",
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  SignUp,
  Login,
  FetchYCUserData,
  ForgotPassword,
  ResetPassword,
};