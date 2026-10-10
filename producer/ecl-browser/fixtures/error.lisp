(format t "before error~%")
(error "acceptance condition ~a" 42)
(format t "unreachable~%")
