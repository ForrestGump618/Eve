# Upstream identities

| Input | Exact identity | Verification boundary |
|---|---|---|
| Official 外部项目 master | 22ddee3792402c3e70ec5f86a63c3e3e895a2f60 | git ls-remote + fixed codeload source archive read; no upstream scripts/tests executed |
| Official latest sampled tag dsh-v0.2.1-rc.3 | 1f81c047fc48fa190a683e469daa699857e9afe8 | ls-remote only; not the audited master snapshot |
| Fixed source ZIP | SHA256 088b7edccadb5577c7cf3898aa899de6a4efab15dc2e7cc80e43a6f8a8df65d3 | 50,937,370 bytes; snapshot has no Git history/signature verification |
| 外部项目 installer | SHA256 fea1c4f21ebd79e3e6a63922f4e64320a5cd5ea697d9863c3462c0165da38b3c | user-supplied local unsigned file; not an upstream code repository |
| SuWen rollback baseline | 8cabac3 / tag suwen-vnext-baseline-20261024 | pre-change clean local source |

Official URLs: https://github.com/deepseek-ai/deepseek-harness and https://deepseek-harness.github.io/deepseek-harness/ . No third-party similarly named project was substituted. Npm versions for the new desktop are pinned in desktop/package-lock.json; use that file for exact registry integrity records.
