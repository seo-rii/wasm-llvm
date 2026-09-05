module calculation
  implicit none
contains
  integer function twice(value)
    integer, intent(in) :: value
    twice = value * 2
  end function
end module

program main
  use calculation
  implicit none
  write(*,'(I0)') twice(21)
end program
