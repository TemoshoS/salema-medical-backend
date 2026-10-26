
import nodemailer from "nodemailer";

const smtpPort = Number(process.env.SMTP_PORT || 587);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendEmailVerificationCode(
  email: string,
  code: string
): Promise<void> {
  const from = process.env.EMAIL_FROM;

  if (!from || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("Email SMTP configuration is incomplete.");
  }

  await transporter.sendMail({
    from,
    to: email,
    subject: "Verify your Salema Medical email",
    text: `Your Salema Medical verification code is ${code}. It expires in 10 minutes. If you did not create this account, you can ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto;">
        <h2>Salema Medical email verification</h2>
        <p>Enter this code in the Salema Medical app to verify your email address:</p>
        <p style="font-size: 30px; font-weight: bold; letter-spacing: 8px;">${code}</p>
        <p>This code expires in <strong>10 minutes</strong>.</p>
        <p>If you did not create this account, you can ignore this email.</p>
      </div>
    `,
  });
}
