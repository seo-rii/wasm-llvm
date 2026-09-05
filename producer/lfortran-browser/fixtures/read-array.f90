program main
  implicit none
  integer :: count
  integer, allocatable :: values(:)
  read(*,*) count
  allocate(values(count))
  read(*,*) values
  write(*,'(I0)') sum(values)
end program
