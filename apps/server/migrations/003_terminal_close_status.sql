-- Intentional close is a finished session, independently of recording completeness.
-- Preserve the original reason, timestamps, recording and audit evidence.
UPDATE terminal_sessions SET status='CLOSED'
WHERE status='INTERRUPTED' AND reason='USER_DISCONNECTED' AND ended_at IS NOT NULL;
