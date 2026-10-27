import { readFileSync } from "node:fs";
const bash = readFileSync(
  new URL("../../../lib/terminal-command-hooks.bash", import.meta.url),
  "utf8",
);
const zsh = readFileSync(
  new URL("../../../lib/terminal-command-hooks.zsh", import.meta.url),
  "utf8",
);
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

// A PTY exec request installs only session-local hooks. It never changes dotfiles
// or the login shell. Unsupported shells retain normal login and recording.
export function terminalShell(token: string, restrictPrivilege = false) {
  if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error("Invalid command token");
  const bashRc = `. /etc/profile\nfor p in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$p" ]; then . "$p"; break; fi
done
__fh_previous_prompt=$(IFS=';'; printf '%s' "\${PROMPT_COMMAND[*]-}")
export FARHELM_COMMAND_TOKEN=${quote(token)}
${bash}`;
  // zsh needs ZDOTDIR to run hooks after the user's normal startup files. Only
  // our private temporary directory is written; it is removed before the prompt.
  const zshRc = `export FARHELM_COMMAND_TOKEN=${quote(token)}\n${zsh}\ncommand rm -- "$__fh_bootdir/.zshenv" "$__fh_bootdir/.zprofile" "$__fh_bootdir/.zshrc" "$__fh_bootdir/.zlogin"\ncommand rmdir -- "$__fh_bootdir"`;
  const script = `case "\${SHELL##*/}" in
bash)
exec "$SHELL" --noprofile --rcfile /dev/fd/3 -i 3<<'FARHELM_BASH_RC'
${bashRc}
FARHELM_BASH_RC
;;
zsh)
__fh_bootdir=$(mktemp -d "\${TMPDIR:-/tmp}/farhelm-shell.XXXXXXXX") || exit 1
export __fh_bootdir
export __fh_original_zdotdir="\${ZDOTDIR:-$HOME}"
for name in .zshenv .zprofile .zshrc .zlogin; do
  printf '%s\n' 'typeset -gr __fh_bootdir' 'ZDOTDIR=$__fh_original_zdotdir' "[[ ! -r \"\$ZDOTDIR/$name\" ]] || source \"\$ZDOTDIR/$name\"" '__fh_original_zdotdir=$ZDOTDIR' 'ZDOTDIR=$__fh_bootdir' > "$__fh_bootdir/$name"
done
printf '%s\n' 'ZDOTDIR=$__fh_original_zdotdir' ${quote(zshRc)} >> "$__fh_bootdir/.zlogin"
export ZDOTDIR=$__fh_bootdir
exec "$SHELL" -il
;;
*) exec "\${SHELL:-/bin/sh}" -il ;;
esac`;
  if (!restrictPrivilege) return script;
  const restricted = `[ "$(/usr/bin/id -u)" != 0 ] || exit 126
[ "$(/usr/bin/awk '$1=="NoNewPrivs:" {print $2}' /proc/$$/status)" = 1 ] || exit 126
printf '\\033]777;farhelm;${token};P;restricted\\007'
${script}`;
  return `PATH=/usr/bin:/bin; export PATH
[ "$(/usr/bin/id -u)" != 0 ] && [ -x /usr/bin/setpriv ] || exit 126
exec /usr/bin/setpriv --no-new-privs -- /bin/sh -c ${quote(restricted)}`;
}
