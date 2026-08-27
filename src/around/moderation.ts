import { Types } from "mongoose";
import { Resend } from "resend";
import { config } from "../config.js";
import {
  AroundBlockModel,
  AroundReportModel,
  ModerationActionModel,
  type AroundReport,
  type ReportReason,
  type ReportTargetType
} from "./models.js";

// UGC compliance helpers (Guideline 1.2): report creation (idempotent per
// reporter/target), email alert to the moderator on every report (24h SLA)
// and the admin action journal.

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

function isDuplicateKeyError(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

export async function createReport(input: {
  targetType: ReportTargetType;
  targetId: Types.ObjectId;
  aroundId?: Types.ObjectId | null;
  reporterId: Types.ObjectId;
  reason: ReportReason;
  comment?: string | null;
}): Promise<{ report: AroundReport; created: boolean }> {
  try {
    const report = await AroundReportModel.create({
      targetType: input.targetType,
      targetId: input.targetId,
      aroundId: input.aroundId ?? null,
      reporterId: input.reporterId,
      reason: input.reason,
      comment: input.comment ?? null,
      status: "open",
      createdAt: new Date()
    });
    return { report: report.toObject() as AroundReport, created: true };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const existing = await AroundReportModel.findOne({
      targetType: input.targetType,
      targetId: input.targetId,
      reporterId: input.reporterId
    }).lean<AroundReport>();
    if (!existing) throw error;
    return { report: existing, created: false };
  }
}

// Fire-and-forget email alert so a human can honour the 24h moderation SLA.
// `targetLabel` carries the offending text itself when there is one (the name
// of a reported around): without it the moderator has to open the admin panel
// just to know what the report is about.
export async function sendReportAlertEmail(report: AroundReport, reporterPseudo: string, targetLabel?: string | null) {
  const to = config.moderationAlertEmail || config.mailAdminBcc || config.mailReplyTo;
  if (!resend || !to) {
    console.warn("[around:moderation] Resend or alert recipient not configured. Skipping report alert email.");
    return;
  }
  const subject = `[Picture me around] New ${report.targetType} report (${report.reason})`;
  const lines = [
    "A new report was filed in Picture me around.",
    "",
    `Target type: ${report.targetType}`,
    `Target id: ${String(report.targetId)}`,
    targetLabel ? `Target text: ${targetLabel}` : "",
    report.aroundId ? `Around id: ${String(report.aroundId)}` : "",
    `Reason: ${report.reason}`,
    report.comment ? `Comment: ${report.comment}` : "",
    `Reporter: ${reporterPseudo}`,
    `Filed at: ${report.createdAt.toISOString()}`,
    "",
    "Moderation SLA: review within 24 hours (App Store UGC requirement).",
    "Open the admin panel > Moderation tab to act on it."
  ].filter(Boolean);

  const { error } = await resend.emails.send({
    from: config.mailFrom,
    to,
    replyTo: config.mailReplyTo,
    subject,
    text: lines.join("\n"),
    headers: { "X-Entity-Ref-ID": `around-report-${String(report._id)}` }
  });
  if (error) {
    throw new Error(`Resend failed for around report ${String(report._id)}: ${error.message}`);
  }
}

export async function logModerationAction(
  action: string,
  targetType: string,
  targetId: Types.ObjectId | null,
  meta?: Record<string, unknown>
) {
  await ModerationActionModel.create({
    action,
    targetType,
    targetId,
    meta: meta ?? null,
    createdAt: new Date()
  });
}

// Bilateral block set for a viewer: users they blocked plus users who blocked
// them. Applied SERVER-SIDE in the feed and member serialisation paths.
export async function bilateralBlockSet(userId: Types.ObjectId): Promise<Set<string>> {
  const blocks = await AroundBlockModel.find({
    $or: [{ blockerId: userId }, { blockedId: userId }]
  }).lean();
  const set = new Set<string>();
  for (const block of blocks) {
    set.add(String(block.blockerId));
    set.add(String(block.blockedId));
  }
  set.delete(String(userId));
  return set;
}
