// Regression cases for the real member-function-pointer ABI used by tzdb's
// ranges projections. Function pointers are Wasm table indices, not aligned
// instruction addresses. Keep source28 failure artifacts alongside native runs.
const families = [
  {
    id: 'invoke-aggregate', stdin: '2\n',
    stdout: 'abi 8 1 1\nview 4 word\nview 3 wor\n',
    code: `#include <cstdio>
#include <cstring>
#include <functional>
#include <string_view>
struct Text { const char* data; unsigned count;
  __attribute__((noinline)) std::string_view whole() const noexcept {return {data,count};}
  __attribute__((noinline)) std::string_view shorted() const noexcept {return {data,count-1};}
};
using Member=std::string_view(Text::*)()const noexcept;
Member volatile functions[]={&Text::whole,&Text::shorted};
int main(){unsigned n;if(std::scanf("%u",&n)!=1||n!=2)return 2;
  unsigned raw[2][2];Member f=functions[0],g=functions[1],null=nullptr;
  static_assert(sizeof(Member)==sizeof(raw[0]));
  std::memcpy(raw[0],&f,sizeof(f));std::memcpy(raw[1],&g,sizeof(g));
  bool odd=((raw[0][0]|raw[1][0])&1)!=0;
  std::printf("abi %zu %d %d\\n",sizeof(Member),odd,null==nullptr&&f!=g&&f!=nullptr);
  std::fflush(stdout);Text value{"word",4};
  for(unsigned i=0;i<n;++i){Member m=functions[i];auto view=std::invoke(m,value);
    std::printf("view %zu %.*s\\n",view.size(),(int)view.size(),view.data());}
}
`
  },
  {
    id: 'ranges-projection', stdin: '3\n', stdout: 'ant bat cat\nlookup 1 bat\n',
    code: `#include <cstdio>
#include <algorithm>
#include <array>
#include <string_view>
struct Entry {const char* data; unsigned size;
  __attribute__((noinline)) std::string_view name()const noexcept{return {data,size};}
};
int main(){unsigned n;if(std::scanf("%u",&n)!=1||n!=3)return 2;
  std::array<Entry,3> values{{{"cat",3},{"ant",3},{"bat",3}}};
  std::ranges::sort(values,{},&Entry::name);
  for(unsigned i=0;i<n;++i)std::printf("%.*s%c",values[i].size,values[i].data,i+1==n?'\\n':' ');
  auto at=std::ranges::lower_bound(values,std::string_view("bat"),{},&Entry::name);
  std::printf("lookup %td %.*s\\n",at-values.begin(),at->size,at->data);
}
`
  },
  {
    id: 'virtual-null', stdin: '7\n', stdout: 'virtual-abi 8 0 1 1\nvirtual 47 47 47\nnull 1 1\n',
    code: `#include <cstdio>
#include <cstring>
#include <functional>
struct Base {int value;explicit Base(int n):value(n){}
  virtual int get(int n)const{return value+n;}
};
struct Derived:Base {using Base::Base;int get(int n)const override{return 2*value+n;}};
using Member=int(Base::*)(int)const;
Member volatile saved=&Base::get;
int main(){int n;if(std::scanf("%d",&n)!=1)return 2;Derived derived{20};Base& base=derived;
  Member member=saved,missing=nullptr;unsigned raw[2];std::memcpy(raw,&member,sizeof(member));
  std::printf("virtual-abi %zu %u %u %d\\n",sizeof(member),raw[0],raw[1]&1,member!=nullptr);
  std::printf("virtual %d %d %d\\n",std::invoke(member,base,n),std::invoke(member,&base,n),std::invoke(member,std::ref(base),n));
  std::printf("null %d %d\\n",missing==nullptr,missing!=member);
}
`
  },
  {
    id: 'inheritance-adjustment', stdin: '5\n', stdout: 'adjustment 1 1 1\nresults 15 25 45 45\nnegative 1 1 1 45\n',
    code: `#include <cstdio>
#include <cstring>
#include <functional>
struct Left {int left=10;__attribute__((noinline)) int plain(int x)const{return left+x;}virtual int virt(int x)const{return left+x;}};
struct Right {int right=20;__attribute__((noinline)) int plain(int x)const{return right+x;}virtual int virt(int x)const{return right+x;}};
struct Joined:Left,Right {int virt(int x)const override{return left+right+3*x;} };
using Member=int(Joined::*)(int)const;
Member volatile methods[]={static_cast<Member>(&Left::plain),static_cast<Member>(&Right::plain),static_cast<Member>(&Right::virt),&Joined::virt};
__attribute__((noinline)) int invoke(Member m,const Joined& o,int x){return std::invoke(m,o,x);}
int main(){int x;if(std::scanf("%d",&x)!=1)return 2;Joined value;
  auto offset=(const char*)(const Right*)&value-(const char*)&value;
  Member plain=methods[1],virt=methods[2];int p[2],v[2];std::memcpy(p,&plain,sizeof(p));std::memcpy(v,&virt,sizeof(v));
  std::printf("adjustment %d %d %d\\n",offset>0,p[1]==2*offset,v[1]==2*offset+1);
  std::printf("results %d %d %d %d\\n",invoke(methods[0],value,x),invoke(methods[1],value,x),invoke(methods[2],value,x),invoke(methods[3],value,x));
  using RMember=int(Right::*)(int)const;
  RMember reverse=static_cast<RMember>(static_cast<Member>(&Joined::virt));int raw[2];std::memcpy(raw,&reverse,sizeof(raw));
  std::printf("negative %d %d %d %d\\n",raw[1]<0,(raw[1]&1)==1,(raw[1]>>1)==-offset,std::invoke(reverse,(const Right&)value,x));
}
`
  }
];
export const timezonePmfCases=families.flatMap(family=>['0','2'].map(optimization=>({
  id:`tzdb-pmf-${family.id}-o${optimization}`,family:family.id,
  request:{language:'cpp',standard:'c++20',optimization,code:family.code},
  run:{stdin:family.stdin,args:[]},stdout:family.stdout,stderr:'',exitCode:0
})));
