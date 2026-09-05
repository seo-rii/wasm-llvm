program eof_input
  implicit none
  integer :: value, status
  read(*,*,iostat=status) value
  if (status < 0) then
    print '(A)', 'EOF'
  else
    print '(I0)', value
  end if
end program eof_input
