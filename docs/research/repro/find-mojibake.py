# -*- coding: utf-8 -*-
import unicodedata

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
t = open(D + r"\docs\requirements\conflicts.md", encoding="utf-8").read()
tokens = ["\ufffd", "\u951b", "\u93c2", "\u95b6", "\u9359", "\u9505", "\u6d93", "\u9428", "\u951f"]
for tok in tokens:
    idx = 0
    while True:
        i = t.find(tok, idx)
        if i < 0:
            break
        print(repr(tok), "at", i, "context:", repr(t[max(0, i - 70): i + 70]))
        idx = i + 1
