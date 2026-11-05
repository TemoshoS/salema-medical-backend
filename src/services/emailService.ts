
import nodemailer from "nodemailer";


const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function verifyEmailConnection(): Promise<void> {
  await transporter.verify();
  console.log("SMTP email connection successful");
}


export async function sendPasswordResetCode(
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
    subject: "Your Salema Medical password reset code",
    text: `Your Salema Medical password reset code is ${code}. It expires in 15 minutes. If you did not request this, you can ignore this email.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto;">
        <h2>Salema Medical password reset</h2>
        <p>Use this code to reset your password:</p>
        <p style="font-size: 30px; font-weight: bold; letter-spacing: 8px;">${code}</p>
        <p>This code expires in <strong>15 minutes</strong> and can only be used once.</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `,
  });
}

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


function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] || character);
}

export async function sendProviderApplicationNotificationEmail(
  recipients: string[],
  details: {
    displayName: string;
    providerType: string;
    serviceArea: string;
  }
): Promise<void> {
  const from = process.env.EMAIL_FROM;

  if (!from || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error("Email SMTP configuration is incomplete.");
  }

  const displayName = details.displayName.slice(0, 160);
  const providerType = details.providerType.slice(0, 80);
  const serviceArea = details.serviceArea.slice(0, 300);

  await transporter.sendMail({
    from,
    to: recipients,
    subject: "New Salema Medical provider application",
    text:
      `A new provider application has been submitted.\\n\\n` +
      `Applicant: ${displayName}\\n` +
      `Provider type: ${providerType}\\n` +
      `Service area: ${serviceArea}\\n\\n` +
      `Sign in to the Salema Medical Control Room and open Provider Applications to review it.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#26183a">
        <h2 style="color:#461477">New provider application</h2>
        <p>A new provider application has been submitted and is awaiting Control Room review.</p>
        <p><strong>Applicant:</strong> ${escapeEmailHtml(displayName)}</p>
        <p><strong>Provider type:</strong> ${escapeEmailHtml(providerType)}</p>
        <p><strong>Service area:</strong> ${escapeEmailHtml(serviceArea)}</p>
        <p>Sign in to the Salema Medical Control Room and open Provider Applications to review it.</p>
        <p style="color:#776d84;font-size:12px">SALEMA MEDICAL · BEYOND EXPECTATIONS</p>
      </div>
    `,
  });
}
