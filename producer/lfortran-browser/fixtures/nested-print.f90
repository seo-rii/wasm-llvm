program nested_print
  implicit none
  integer :: i, total
  total = 0
  do i = 1, 3
    total = total + i
    if (i < 3) then
      print '(A,I0)', 'if=', i
    end if
    print '(A,I0)', 'loop=', i
  end do
  print '(A,I0)', 'total=', total
end program nested_print
