---
name: csv-analysis
description: "CSV tabular data inspection numeric summary; CSV 表格 数据 汇总 分析"
---

Read the actual CSV file through read_file, then run with {"csv":"column1,column2\n1,2\n3,4"}. The script returns row count, column names and numeric summaries. It treats nonnumeric columns as text and does not invent missing values.
