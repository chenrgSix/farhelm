# Loaded once at the first interactive prompt. No keystrokes or child-process
# input are collected. These are shell-reported command lines, not OS auditd.
__fh_emit() {
    builtin printf '\033]777;farhelm;%s;%s\007' "$FARHELM_COMMAND_TOKEN" "$1"
}
__fh_end() {
    if [[ ${__fh_active:-0} == 1 ]]; then
        __fh_emit "E;$1"
        __fh_active=0
    fi
}
__fh_preexec() {
    [[ ${__fh_internal:-0} == 0 && ${__fh_active:-0} == 0 && $BASH_COMMAND != __fh_prompt ]] || return 0
    __fh_active=1
    local line
    line=$(HISTTIMEFORMAT= builtin history 1)
    if [[ $line =~ ^[[:space:]]*[0-9]+[[:space:]]+(.*)$ ]]; then
        line=${BASH_REMATCH[1]}
    else
        line=$BASH_COMMAND
    fi
    if [[ ${#line} -gt 8192 ]]; then
        __fh_emit 'X;limit'
    else
        __fh_emit "C;$(builtin printf '%s' "$line" | command base64 | command tr -d '\r\n')"
    fi
    return 0
}
__fh_prompt() {
    local status=$?
    local __fh_internal=1
    __fh_end "$status"
    if [[ -n ${__fh_previous_prompt:-} ]]; then
        (exit "$status")
        builtin eval -- "$__fh_previous_prompt"
    fi
    return "$status"
}
# Session-local history is needed to preserve the submitted line (including
# multiline commands, completion and edits). Never write it to a history file.
HISTFILE=/dev/null
HISTCONTROL=
HISTIGNORE=
HISTSIZE=1000
set -o history
shopt -s cmdhist lithist
__fh_active=0
PROMPT_COMMAND=__fh_prompt
trap '__fh_end "$?"' EXIT
__fh_emit 'R;bash'
trap '__fh_preexec' DEBUG
