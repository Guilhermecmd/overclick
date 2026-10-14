// SOP-177: the claim guard must let PROVABLY read-only compound commands run
// without a claim (pipes, &&, ;, $(...) and `for` loops whose every part reads),
// while every write shape keeps requiring one. Run: node --test scripts/test-claim-guard-reads.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandReadOnly, commandWrites } from "../plugin/hooks/common.mjs";

// What claim-guard.mjs does for a shell command (mutationSuspected, minus
// specOnlyPublish which needs a real repository).
const mutation = (command) => commandWrites(command) || !commandReadOnly(command);

const READS = [
  // the real cases of the report
  "git worktree list | grep -c SOP-132",
  "git worktree list && git branch --list 'sop-132-*'",
  'for f in docs/modulos/M*.md; do echo "$f: $(grep -m1 "^# " $f | cut -c1-120)"; done',
  "sed -n 472p docs/DECISOES.md | cut -c1-700",
  "grep -n 'D-28' docs/DECISOES.md | cut -c1-200",
  "cat docs/ESTADO.md && git show --stat HEAD | head -6",
  "wc -w docs/ESTADO.md && grep -n 'G0' docs/ESTADO.md | cut -c1-80",
  // more of the same families
  "git log --oneline -5 | head -3; git status --short",
  "ls docs | sort | uniq | tail -3",
  "find docs -name '*.md' -type f | head",
  "echo $(git rev-parse --short HEAD)",
  "echo \"branch: $(git branch --show-current)\"",
  "for f in a.md b.md; do wc -l $f; done",
  "for f in docs/*.md; do echo $f; done | sort",
  "for f in $(ls docs); do wc -c docs/$f; done",
  "git log --oneline 2>/dev/null | head -3",
  "grep -c foo file 2>&1 | cut -c1-5",
  "cat a | tr a-z A-Z | head -2",
  "git diff HEAD~1 | grep '^+' | wc -l",
  "ls $(git rev-parse --show-toplevel)",
  "git --no-pager log --oneline -3",
  "git remote -v | head -2",
  "git branch --list 'sop-*' | wc -l",
  "grep -n 'git commit' docs/GIT.md | cut -c1-80",
  "grep -rn \"install\" docs | head -3",
  "echo 'rm -rf x' | wc -c",
  "git show \"$(git rev-parse HEAD)\" --stat | head -3",
  "ls # a comment ; rm x",
  "for f in docs/modulos/*.md; do sed -n 1p \"$f\" | cut -c1-60; done",
  "for f in a b; do for g in c d; do echo $f$g; done; done",
];

const WRITES = [
  "echo x > /tmp/f",
  "echo x >> docs/a.md",
  "cat a | tee out.txt",
  "sed -i 's/a/b/' f",
  "sed -i.bak 's/a/b/' f",
  "sed -n '1w out' f | cut -c1-5",
  "find . -name '*.tmp' -delete",
  "find . -name '*.tmp' -exec rm {} \\;",
  "find . -name x -fprint out",
  "git commit -m x",
  "git add a && git status",
  "git worktree add ../x b | head",
  "git branch -D foo",
  "git branch newname | head",
  "git push | cat",
  "ls && rm -rf x",
  "ls | xargs rm",
  "git log | foo",
  "unknownverb --x",
  'for f in a b; do rm $f; done',
  'for f in a b; do echo $f > $f; done',
  'for f in $(rm -rf x; ls); do echo $f; done',
  'for f in a; do touch $f; done',
  'for f in *; do sed -i s/a/b/ $f; done',
  'echo $(rm -rf x)',
  'echo "$(touch y)"',
  'echo `touch y`',
  'for f in a; do wc -c $f; done; rm x',
  'cat a | sort -o out',
  "grep -n x f | tee g",
  "while true; do rm x; done",
  "for f in a; do echo $f; done > out",
  "for f in a; do echo $f; done | tee out",
  "ls | (rm x)",
  "if true; then rm x; fi",
  "cat <(rm x)",
  "git -C other commit -m x",
  "sed -n 'w out' f",
  "sed '1,3w out' f | head",
  "sed -e 's/a/b/w out' f | head",
  "sed -n 's/a/b/e' f | head",
  "find . -execdir rm {} +",
  "find . -ok rm {} \\;",
  "sort -o out f | head",
  "git config user.name x | cat",
  "git stash | cat",
  "gh pr create | cat",
  "env rm x | cat",
  "cat a; (rm x)",
  "{ rm x; }",
  // parser-differential holes: escaped quote / comment hiding a separator
  "echo \\\" ; rm x ; echo \\\"",
  "echo a # '\nrm x\necho '",
  "git log --output=out.txt",
  "git show --output=out HEAD | head",
  "git grep -Ovim foo",
  "git branch --list foo bar | cat; git branch newname",
  "git branch newname",
  "find . $(echo -delete)",
  "sed $(echo -i) s/a/b/ f",
  "for f in $(echo -delete); do find . $f; done",
  "for f in -delete; do find . $f; done",
  "for f in a; do find . $f -delete; done",
  "for f in a; do echo $f",
  "done",
  "do echo x; done",
  "for f in a; do rm $f; done | cat",
  "echo $(ls",
  "echo $(rm x)$(ls)",
  "date -s '2020-01-01' | cat",
  "rg --pre 'rm x' foo | head",
  "yq -i '.a=1' f.yaml | head",
  "sed -n '1e touch x' f | head",
  "echo $'a'; rm x",
];

for (const command of READS) {
  test(`read-only passes without a claim: ${command}`, () => {
    assert.equal(mutation(command), false);
  });
}

for (const command of WRITES) {
  test(`write still needs a claim: ${command}`, () => {
    assert.equal(mutation(command), true);
  });
}
