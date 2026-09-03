# معمارية الحماية — منصة عبده السجاعي

هذه الوثيقة تميز بين ما يمكن فرضه من الخادم وما هو مجرد طبقة ردع داخل المتصفح.

## 1) الحساب والجلسة
- bcrypt لكلمات المرور.
- Access Token قصير العمر.
- Refresh Token rotation مع hash فقط.
- إلغاء الجلسات القديمة عند تسجيل الدخول/التسجيل.
- قفل مؤقت بعد 5 محاولات فاشلة؛ في الإنتاج يجب نقل الحالة إلى Redis أو قاعدة البيانات لتعمل عبر عدة نسخ.
- Audit Log مع IP وUser-Agent والوقت.

## 2) الوصول للمحتوى
- كل مورد يحمل grade.
- الخادم يتحقق من role + grade + ownership قبل إصدار grant.
- رابط الوسائط المؤقت موقع بـ HMAC ومرتبط بالمستخدم والمورد ووقت انتهاء.
- لا يتم إرسال sourceRef الخام في قائمة فيديوهات الطالب.
- إلغاء الـ grant ممكن قبل انتهاء صلاحيته.

## 3) الفيديو
الطبقة الحالية تنفذ signed grants وwatermark metadata ومنع seeking كإعداد. التنفيذ الإنتاجي المطلوب حسب المتطلبات يحتاج مزود بث يدعم DRM مثل Cloudflare Stream أو CloudFront مع مزود DRM، وليس JavaScript وحده.

## 4) PDF
الخادم لا يعرض storageKey للطالب. يجب أن يكون الـ reader الإنتاجي proxy/stream من الخادم مع watermark لكل صفحة، وتعطيل print/download/copy في واجهة القارئ. هذه القيود ليست ضماناً مطلقاً ضد تصوير الشاشة.

## 5) مكافحة الغش
يتم تسجيل visibility/focus/tab/fullscreen/screen-capture events من الواجهة وإرسالها للخادم. هذه signals وليست دليلاً تقنياً مطلقاً على تصوير الشاشة أو الغش؛ القرار النهائي يجب أن يتبع سياسة الامتحان.

## 6) الإنتاج
قبل Production Ready يجب تفعيل PostgreSQL + Redis، object storage، DRM، TLS/HSTS، centralized logging، backups، load testing، OWASP testing، penetration testing، ومراقبة 24/7.
