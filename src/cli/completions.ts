import type { Command } from "commander";

/** Derive candidates from Commander so a newly registered option is completed automatically. */
export function completionWords(program: Command, words: string[], aliases: string[] = []): string[] {
  let command = program;
  for (const word of words) {
    const child = command.commands.find(c => c.name() === word || c.aliases().includes(word));
    if (child) command = child;
  }
  return [...new Set([
    ...command.commands.flatMap(c => [c.name(), ...c.aliases()]),
    ...command.options.flatMap(o => [o.short, o.long].filter((v): v is string => Boolean(v))),
    "--help", ...(command === program ? aliases : []),
    ...(command.name() === "config" ? ["validate", "auto-restart"] : []),
  ])].sort();
}
export function completionScript(shell: string): string {
  if (shell === "bash") return `_loom() {
  local -a words=()
  local i last word cur prefix
  # Bash splits colon commands such as agents:mode into several COMP_WORDS.
  for ((i=0; i<=COMP_CWORD; i++)); do
    word="\${COMP_WORDS[i]}"
    last=$((\${#words[@]}-1))
    if ((last >= 0)) && { [[ "$word" == :* ]] || [[ "\${words[last]}" == *: ]]; }; then
      words[last]="\${words[last]}$word"
    else
      words+=("$word")
    fi
  done
  last=$((\${#words[@]}-1))
  cur="\${words[last]}"
  COMPREPLY=( $(compgen -W "$(loom completion candidates -- "\${words[@]:1:last-1}")" -- "$cur") )
  if [[ "$COMP_WORDBREAKS" == *:* && "$cur" == *:* ]]; then
    prefix="\${cur%:*}:"
    for ((i=0; i<\${#COMPREPLY[@]}; i++)); do COMPREPLY[i]="\${COMPREPLY[i]#"$prefix"}"; done
  fi
}
complete -F _loom loom loompad`;
  if (shell === "zsh") return `_loom() {
  local -a candidates
  candidates=("\${(@f)$(loom completion candidates -- "\${words[@]:1:$((CURRENT-2))}")}")
  compadd -- "\${candidates[@]}"
}
compdef _loom loom loompad 2>/dev/null || { autoload -Uz compinit && compinit && compdef _loom loom loompad; }`;
  if (shell === "fish") return `complete -c loom -f -a '(loom completion candidates -- (commandline -opc)[2..-1])'\ncomplete -c loompad -w loom`;
  throw new Error(`unknown shell "${shell}" — zsh, bash or fish`);
}
