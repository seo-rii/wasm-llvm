(defun depth (n) (if (= n 0) 0 (+ 1 (depth (- n 1)))))
(format t "depth=~d~%" (depth 100))
(finish-output)
;; Unbounded recursion exhausts the JavaScript engine's native stack before
;; ECL's own C-stack guard fires; the host must observe it as a trap.
(depth 100000000)
(format t "unreachable~%")
