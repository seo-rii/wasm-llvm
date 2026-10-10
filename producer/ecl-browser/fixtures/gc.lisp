;; Allocates far more than the initial heap so the Boehm collector must run
;; repeatedly while live data is reachable only from the Wasm stack.
(defun build (n) (loop for i below n collect (format nil "item-~d" i)))
(defvar *keep* (make-hash-table :test #'equal))
(dotimes (round 12)
  (let ((xs (build 20000)))
    (setf (gethash round *keep*) (nth round xs))
    (unless (string= (car (last xs)) "item-19999") (error "corrupt list ~a" round))))
(dotimes (round 12)
  (unless (string= (gethash round *keep*) (format nil "item-~d" round))
    (error "corrupt hash ~a" round)))
(defclass point () ((x :initarg :x :reader x)))
(defgeneric norm (p))
(defmethod norm ((p point)) (abs (x p)))
(format t "clos=~d~%"
        (reduce #'+ (mapcar #'norm (loop for i from -500 to 500 collect (make-instance 'point :x i)))))
(format t "gc ok~%")
