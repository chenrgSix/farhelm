export const PASSWORD_HINT = "至少 8 个字符，必须同时包含英文字母和数字。";
export const PASSWORD_PATTERN =
  "(?=[\\s\\S]*[A-Za-z])(?=[\\s\\S]*[0-9])[\\s\\S]{8,1024}";
export function isAccountPassword(value: string) {
  return (
    value.length >= 8 &&
    value.length <= 1024 &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value)
  );
}
