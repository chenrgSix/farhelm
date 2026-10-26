# zsh supplies the accepted, unexpanded command line to preexec. It does not
# include subsequent input to sudo/read/editors/REPLs.
function __fh_emit { builtin printf '\033]777;farhelm;%s;%s\007' "$FARHELM_COMMAND_TOKEN" "$1" }
function __fh_preexec {
    __fh_active=1
    if (( ${#1} > 8192 )); then
        __fh_emit 'X;limit'
    else
        __fh_emit "C;$(builtin printf '%s' "$1" | command base64 | command tr -d '\r\n')"
    fi
}
function __fh_end {
    local result=$?
    if [[ ${__fh_active:-0} == 1 ]]; then
        __fh_emit "E;$result"
        __fh_active=0
    fi
    return $result
}
HISTFILE=/dev/null
__fh_active=0
preexec_functions=(__fh_preexec ${preexec_functions:#__fh_preexec})
precmd_functions=(__fh_end ${precmd_functions:#__fh_end})
zshexit_functions=(__fh_end ${zshexit_functions:#__fh_end})
__fh_emit 'R;zsh'
