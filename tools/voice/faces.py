"""Find faces in a JPEG read from stdin. Prints JSON: {"faces":[{"x","y","w","h"}]} as fractions of the picture, left to right.
Runs on this machine only. Needs OpenCV (cv2); prints {"faces":[]} when it is missing."""
import json, os, sys
try:
    import cv2, numpy as np
    data = np.frombuffer(sys.stdin.buffer.read(), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    H, W = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    cascade = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_alt2.xml"))
    side = max(40, int(min(W, H) * 0.09))
    found = cascade.detectMultiScale(gray, 1.1, 3, minSize=(side, side))
    faces = sorted(({"x": x / W, "y": y / H, "w": w / W, "h": h / H} for (x, y, w, h) in found), key=lambda f: f["x"])
    print(json.dumps({"faces": faces}))
except Exception as e:  # no detector: the page falls back to boxes the payer drags
    print(json.dumps({"faces": [], "error": str(e)[:120]}))
