# Kết quả đo (tự sinh bởi scripts/report.js)

- Phiên đo: 2026-10-08T02:46:33.555Z, trình duyệt msedge 154.0.4258.62, Node v24.10.0, Windows_NT 10.0.26200 x64, CPU 12th Gen Intel(R) Core(TM) i7-1260P
- Tham số: {"rounds":5,"warm":5,"matrices":["main","throttle","fault"],"datasets":["small","large"],"throttleMs":100}
- Log thô: `logs/measure-2026-10-08T02-46-33-076Z/*.jsonl` · bảng thô: `results/raw/runs.csv` (570 lần chạy) · tổng hợp: `results/summary.csv`
- Cách đếm: client request lấy từ Playwright (tương đương HAR); preflight, service call và DB query lấy từ log theo `rid`.
- Ô có dạng `median [min–max]`; chỉ có một số nghĩa là mọi lần chạy cho cùng giá trị.

### Ma trận chính · small · cold

| Biến thể | Client | Data | Mode | n | t_data ms median [min–max] | t_complete ms | Client req (+preflight) | User call/DB | Order call/DB | Product call/DB | cache-hit | Payload |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | web | small | cold | 5 | 84.5 [64.7–131.3] | 155.1 | 3 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 9.2 KB (gzip 1.2) |
| bff | web | small | cold | 5 | 106.4 [80.6–136.4] | 178.2 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 4.7 KB (gzip 0.8) |
| gql-naive | web | small | cold | 5 | 118.7 [110.3–141.8] | 197.3 | 1 (+1) | 1 / 1 | 1 / 2 | 19 / 19 | 0 | 4.7 KB (gzip 0.8) |
| gql-batched | web | small | cold | 5 | 115.4 [90.7–132.2] | 194.1 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 1 | 13 | 4.7 KB (gzip 0.8) |
| bff | mobile | small | cold | 5 | 107.8 [88.9–135.9] | 169.7 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 1 | 0 | 1.9 KB (gzip 0.3) |
| gql-naive | mobile | small | cold | 5 | 116.6 [107–124.6] | 190.7 | 1 (+1) | 0 / 0 | 1 / 2 | 19 / 19 | 0 | 1.9 KB (gzip 0.3) |
| gql-batched | mobile | small | cold | 5 | 102.5 [88.1–139.4] | 184 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 1 | 13 | 1.9 KB (gzip 0.3) |

### Ma trận chính · small · warm

| Biến thể | Client | Data | Mode | n | t_data ms median [min–max] | t_complete ms | Client req (+preflight) | User call/DB | Order call/DB | Product call/DB | cache-hit | Payload |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | web | small | warm | 25 | 82.5 [39.3–142.3] | 147.2 | 3 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 9.2 KB (gzip 1.2) |
| bff | web | small | warm | 25 | 51 [31–75.6] | 127 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 4.7 KB (gzip 0.8) |
| gql-naive | web | small | warm | 25 | 66.9 [36.5–137.6] | 146.2 | 1 (+1) | 1 / 1 | 1 / 2 | 19 / 19 | 0 | 4.7 KB (gzip 0.8) |
| gql-batched | web | small | warm | 25 | 49.4 [34.6–80.7] | 124 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 1 | 13 | 4.7 KB (gzip 0.8) |
| bff | mobile | small | warm | 25 | 40.1 [30.3–70.3] | 108 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 1 | 0 | 1.9 KB (gzip 0.3) |
| gql-naive | mobile | small | warm | 25 | 55.1 [32.5–97.7] | 140.1 | 1 (+1) | 0 / 0 | 1 / 2 | 19 / 19 | 0 | 1.9 KB (gzip 0.3) |
| gql-batched | mobile | small | warm | 25 | 47.3 [30.6–80.4] | 130.1 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 1 | 13 | 1.9 KB (gzip 0.3) |

### Ma trận chính · large · cold

| Biến thể | Client | Data | Mode | n | t_data ms median [min–max] | t_complete ms | Client req (+preflight) | User call/DB | Order call/DB | Product call/DB | cache-hit | Payload |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | web | large | cold | 5 | 132.5 [109.8–153] | 211 | 3 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 93.8 KB (gzip 5.1) |
| bff | web | large | cold | 5 | 138.3 [111–158.6] | 216 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 92.2 KB (gzip 4.6) |
| gql-naive | web | large | cold | 5 | 429.8 [394.5–505.1] | 532.4 | 1 (+1) | 1 / 1 | 1 / 2 | 399 / 399 | 0 | 92.2 KB (gzip 4.6) |
| gql-batched | web | large | cold | 5 | 178.9 [146.6–185.4] | 267.4 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 1 | 369 | 92.2 KB (gzip 4.6) |
| bff | mobile | large | cold | 5 | 134 [104.2–154] | 225.5 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 1 | 0 | 38.1 KB (gzip 1.6) |
| gql-naive | mobile | large | cold | 5 | 393.9 [371.4–438.9] | 472.8 | 1 (+1) | 0 / 0 | 1 / 2 | 399 / 399 | 0 | 38.1 KB (gzip 1.6) |
| gql-batched | mobile | large | cold | 5 | 127.1 [110.5–170.7] | 232 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 1 | 369 | 38.1 KB (gzip 1.6) |

### Ma trận chính · large · warm

| Biến thể | Client | Data | Mode | n | t_data ms median [min–max] | t_complete ms | Client req (+preflight) | User call/DB | Order call/DB | Product call/DB | cache-hit | Payload |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | web | large | warm | 25 | 114.3 [80.6–147.5] | 193.3 | 3 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 93.8 KB (gzip 5.1) |
| bff | web | large | warm | 25 | 83.8 [67.7–140.7] | 156.3 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 92.2 KB (gzip 4.6) |
| gql-naive | web | large | warm | 25 | 321.9 [144.9–387] | 395.8 | 1 (+1) | 1 / 1 | 1 / 2 | 399 / 399 | 0 | 92.2 KB (gzip 4.6) |
| gql-batched | web | large | warm | 25 | 114.8 [74.2–158.7] | 182.9 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 1 | 369 | 92.2 KB (gzip 4.6) |
| bff | mobile | large | warm | 25 | 69.1 [39.7–106.3] | 144.3 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 1 | 0 | 38.1 KB (gzip 1.6) |
| gql-naive | mobile | large | warm | 25 | 291.9 [114.9–389.8] | 363.8 | 1 (+1) | 0 / 0 | 1 / 2 | 399 / 399 | 0 | 38.1 KB (gzip 1.6) |
| gql-batched | mobile | large | warm | 25 | 81.4 [52.6–126.3] | 151.7 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 1 | 369 | 38.1 KB (gzip 1.6) |

### Throttle RTT +100 ms · small · warm

| Biến thể | Client | Data | Mode | n | t_data ms median [min–max] | t_complete ms | Client req (+preflight) | User call/DB | Order call/DB | Product call/DB | cache-hit | Payload |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | web | small | warm | 5 | 406.5 [394.1–421.3] | 917.8 | 3 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 9.2 KB (gzip 1.2) |
| bff | web | small | warm | 5 | 156.5 [149.9–163.8] | 685.6 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 4.7 KB (gzip 0.8) |
| gql-naive | web | small | warm | 5 | 177 [156.8–190.9] | 718.1 | 1 (+1) | 1 / 1 | 1 / 2 | 19 / 19 | 0 | 4.7 KB (gzip 0.8) |
| gql-batched | web | small | warm | 5 | 171.9 [162.5–174.8] | 692.2 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 1 | 13 | 4.7 KB (gzip 0.8) |
| bff | mobile | small | warm | 5 | 165.4 [155.3–172.7] | 688.7 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 1 | 0 | 1.9 KB (gzip 0.3) |
| gql-naive | mobile | small | warm | 5 | 170 [155.8–173.1] | 699.3 | 1 (+1) | 0 / 0 | 1 / 2 | 19 / 19 | 0 | 1.9 KB (gzip 0.3) |
| gql-batched | mobile | small | warm | 5 | 164.9 [158.7–166.5] | 710.2 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 1 | 13 | 1.9 KB (gzip 0.3) |

### Throttle RTT +100 ms · large · warm

| Biến thể | Client | Data | Mode | n | t_data ms median [min–max] | t_complete ms | Client req (+preflight) | User call/DB | Order call/DB | Product call/DB | cache-hit | Payload |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | web | large | warm | 5 | 455.6 [435.5–458.3] | 988.2 | 3 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 93.8 KB (gzip 5.1) |
| bff | web | large | warm | 5 | 203 [184.1–223.5] | 763.5 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 92.2 KB (gzip 4.6) |
| gql-naive | web | large | warm | 5 | 192.9 [177.7–229.4] | 713.5 | 1 (+1) | 1 / 1 | 1 / 2 | 399 / 399 | 0 | 92.2 KB (gzip 4.6) |
| gql-batched | web | large | warm | 5 | 173.9 [171.1–184.3] | 681.9 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 1 | 369 | 92.2 KB (gzip 4.6) |
| bff | mobile | large | warm | 5 | 178.8 [168.6–190.8] | 716.3 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 1 | 0 | 38.1 KB (gzip 1.6) |
| gql-naive | mobile | large | warm | 5 | 175.6 [151–191.5] | 707 | 1 (+1) | 0 / 0 | 1 / 2 | 399 / 399 | 0 | 38.1 KB (gzip 1.6) |
| gql-batched | mobile | large | warm | 5 | 164.9 [164.3–184.7] | 719.3 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 1 | 369 | 38.1 KB (gzip 1.6) |

### Product Service chậm/lỗi · small · warm

| Biến thể | Client | Data | Mode | n | t_data ms median [min–max] | t_complete ms | Client req (+preflight) | User call/DB | Order call/DB | Product call/DB | cache-hit | Payload | Fault | Màn hình | Mã lỗi | Call timeout |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bff | web | small | warm | 5 | 351.3 [349.9–358.9] | 396.2 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 1 | 0 | 4.7 KB (gzip 0.8) | delay300 | ok | – | 0 |
| gql-batched | web | small | warm | 5 | 359.5 [349.1–370.2] | 404 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 1 | 13 | 4.7 KB (gzip 0.8) | delay300 | ok | – | 0 |
| bff | mobile | small | warm | 5 | 347.5 [344.9–348.6] | 397.4 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 1 | 0 | 1.9 KB (gzip 0.3) | delay300 | ok | – | 0 |
| gql-batched | mobile | small | warm | 5 | 353 [337.6–357.4] | 399.2 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 1 | 13 | 1.9 KB (gzip 0.3) | delay300 | ok | – | 0 |
| bff | web | small | warm | 5 | 1064.6 [1044.1–1071.6] | 1108.3 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 0 | 0 | 6.0 KB (gzip 0.8) | delay3000 | partial | PRODUCT_TIMEOUT | 1 |
| gql-batched | web | small | warm | 5 | 1071.2 [1048–1077.4] | 1114.3 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 0 | 13 | 6.8 KB (gzip 0.8) | delay3000 | partial | PRODUCT_TIMEOUT | 1 |
| bff | mobile | small | warm | 5 | 1047.9 [1036.4–1055.1] | 1091.9 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 0 | 0 | 3.7 KB (gzip 0.4) | delay3000 | partial | PRODUCT_TIMEOUT | 1 |
| gql-batched | mobile | small | warm | 5 | 1056.9 [1054.7–1057.9] | 1104.1 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 0 | 13 | 4.5 KB (gzip 0.4) | delay3000 | partial | PRODUCT_TIMEOUT | 1 |
| bff | web | small | warm | 5 | 42 [38.4–49.8] | 88.3 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 0 | 0 | 5.9 KB (gzip 0.8) | error500 | partial | PRODUCT_UNAVAILABLE | 0 |
| gql-batched | web | small | warm | 5 | 41.4 [38.3–53.5] | 90.1 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 0 | 13 | 6.8 KB (gzip 0.8) | error500 | partial | PRODUCT_UNAVAILABLE | 0 |
| bff | mobile | small | warm | 5 | 36.4 [28.8–42.1] | 87.1 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 0 | 0 | 3.6 KB (gzip 0.4) | error500 | partial | PRODUCT_UNAVAILABLE | 0 |
| gql-batched | mobile | small | warm | 5 | 38.6 [36.1–40.6] | 83.6 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 0 | 13 | 4.4 KB (gzip 0.4) | error500 | partial | PRODUCT_UNAVAILABLE | 0 |
| bff | web | small | warm | 5 | 1051.3 [1042.1–1064.8] | 1099.8 | 1 (+0) | 1 / 1 | 1 / 2 | 1 / 0 | 0 | 6.0 KB (gzip 0.8) | hang | partial | PRODUCT_TIMEOUT | 1 |
| gql-batched | web | small | warm | 5 | 1051.1 [1042.2–1088.8] | 1106.5 | 1 (+1) | 1 / 1 | 1 / 2 | 1 / 0 | 13 | 6.8 KB (gzip 0.8) | hang | partial | PRODUCT_TIMEOUT | 1 |
| bff | mobile | small | warm | 5 | 1037.4 [1025.7–1040.4] | 1080.1 | 1 (+0) | 0 / 0 | 1 / 2 | 1 / 0 | 0 | 3.7 KB (gzip 0.4) | hang | partial | PRODUCT_TIMEOUT | 1 |
| gql-batched | mobile | small | warm | 5 | 1063.6 [1058.9–1068] | 1139.7 | 1 (+1) | 0 / 0 | 1 / 2 | 1 / 0 | 13 | 4.5 KB (gzip 0.4) | hang | partial | PRODUCT_TIMEOUT | 1 |

